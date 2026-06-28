/** Column metadata returned alongside `postgres_query_table`. */
export interface DataColumn {
  name: string;
  data_type: string;
  ordinal_position: number;
  is_nullable: boolean;
}

/** Direction passed to the backend; lowercase to match `SortDirection` over IPC. */
export type SortDirection = "asc" | "desc";

export interface OrderBy {
  column: string;
  direction: SortDirection;
}

// --------------------------------------------------------------------------
// Structured filter model (postgres-data-grid capability)
// --------------------------------------------------------------------------

/**
 * Operator surface — mirrors the closed Rust `Operator` enum on the wire.
 * SQL keywords stay uppercase; sugar operators are PascalCase.
 */
export type Operator =
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "LIKE"
  | "NOT LIKE"
  | "ILIKE"
  | "NOT ILIKE"
  | "Contains"
  | "StartsWith"
  | "EndsWith"
  | "In"
  | "NotIn"
  | "BETWEEN"
  | "IS NULL"
  | "IS NOT NULL"
  | "RAW";

/** Either a named column or the special "Any column" pseudo-column, or a raw SQL expression column. */
export type ColumnRef =
  | { kind: "named"; name: string }
  | { kind: "any_column" }
  | { kind: "raw" };

/** Scalar value bindable to a filter parameter. The backend rejects null. */
export type FilterScalar = string | number | boolean;

/**
 * Operator-shaped value. Most ops want a scalar; In/NotIn want an array;
 * BETWEEN wants `{min, max}`; null variants want absent.
 */
export type FilterValue =
  | FilterScalar
  | FilterScalar[]
  | { min: FilterScalar; max: FilterScalar };

export interface Condition {
  column: ColumnRef;
  op: Operator;
  value?: FilterValue;
}

/**
 * A single row in the flat filter list. `enabled` gates inclusion in Apply All
 * but does NOT affect per-row Apply.
 */
export interface FilterRow {
  enabled: boolean;
  column: ColumnRef;
  op: Operator;
  value?: FilterValue;
}

/**
 * Flat filter tree — a list of condition rows joined by one root combinator.
 * Nesting (or_group) is not expressible in this model; the backend still
 * accepts or_group for backward-compat but the frontend never emits it.
 */
export interface FilterTree {
  rows: FilterRow[];
  combinator: "AND" | "OR";
}

export type FilterModel = FilterTree;

/**
 * Wire-level condition node — mirrors the Rust `FilterNode::Condition` variant.
 * Used only for serializing the payload in `modelToPayload`.
 */
export interface WireCondition {
  kind: "condition";
  column: ColumnRef;
  op: Operator;
  value?: FilterValue;
}

export const EMPTY_FILTER_ROW: FilterRow = {
  enabled: true,
  column: { kind: "any_column" },
  op: "Contains",
  value: "",
};

export const EMPTY_FILTER_TREE: FilterTree = { rows: [], combinator: "AND" };

export const EMPTY_FILTER_MODEL: FilterModel = EMPTY_FILTER_TREE;

export interface QueryTableOptions {
  limit: number;
  offset: number;
  order_by?: OrderBy[];
  filter_tree?: { children: WireCondition[]; combinator: "AND" | "OR" };
  raw_where?: string;
}

export interface CountTableOptions {
  filter_tree?: { children: WireCondition[]; combinator: "AND" | "OR" };
  raw_where?: string;
}

/**
 * Cell envelope returned for `bytea` (always) or any value whose JSON
 * representation exceeds the backend's truncation threshold (~1 MB).
 * Direct values come through as plain JSON primitives or objects.
 */
export interface CellEnvelope {
  kind: "binary" | "truncated";
  preview: string;
  byte_length: number;
}

export type CellValue = string | number | boolean | null | CellEnvelope | unknown[] | Record<string, unknown>;

export function isCellEnvelope(v: unknown): v is CellEnvelope {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    (o.kind === "binary" || o.kind === "truncated") &&
    typeof o.preview === "string" &&
    typeof o.byte_length === "number"
  );
}

export interface QueryTableResult {
  columns: DataColumn[];
  rows: CellValue[][];
  applied: {
    limit: number;
    offset: number;
    order_by: OrderBy[];
    filter_tree: { children: WireCondition[]; combinator: "AND" | "OR" } | null;
    raw_where: string | null;
  };
  query_ms: number;
  truncated_columns: string[];
}

export interface CountTableResult {
  count: number;
  query_ms: number;
}

/** Relation kinds the data viewer supports. Matches the schema browser's tree. */
export type RelationKind = "table" | "view" | "materialized-view";

// --------------------------------------------------------------------------
// Edit-table types (postgres-data-edit capability)
// --------------------------------------------------------------------------

/** Value bound to an edit op. Anything that survives JSON serialization. */
export type EditValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: unknown }
  | unknown[];

/**
 * Discriminated union of edit operations. `pk` and `changes`/`values` are
 * column → value maps. The backend serializes these as `BTreeMap`s for
 * deterministic SQL generation.
 */
export type EditOp =
  | { kind: "update"; pk: Record<string, EditValue>; changes: Record<string, EditValue> }
  | { kind: "insert"; values: Record<string, EditValue> }
  | { kind: "delete"; pk: Record<string, EditValue> };

export interface TableEditMetadata {
  /** PK column names in declared order. `null` when the relation has no PK. */
  pk_columns: string[] | null;
  /** Map: column name → ordered enum labels. Empty when no enum columns. */
  enums: Record<string, string[]>;
}

export interface RefreshedRow {
  pk: Record<string, EditValue>;
  /** `null` when the op affected zero rows (e.g. UPDATE on missing PK). */
  row: CellValue[] | null;
}

/**
 * Discriminated outcome of a `postgres_apply_table_edits` call. Distinct from
 * thrown errors (read-only / shape) which surface as `AppError`.
 */
export type ApplyEditsOutcome =
  | {
      outcome: "ok";
      committed: number;
      refreshed_rows: RefreshedRow[];
      query_ms: number;
    }
  | {
      outcome: "op_failed";
      code: string | null;
      message: string;
      failed_op_index: number;
    };

// --------------------------------------------------------------------------
// FilterTree helpers
// --------------------------------------------------------------------------

/**
 * Project a UI-level `FilterModel` to the wire payload accepted by
 * `postgres_query_table` / `postgres_count_table`. Emits `filter_tree` with
 * `children` as condition nodes (backend wire shape). `enabled` is a
 * client-only flag and is NOT sent on the wire.
 */
export function modelToPayload(model: FilterModel): {
  filter_tree?: { children: WireCondition[]; combinator: "AND" | "OR" };
} {
  const enabled = model.rows.filter((r) => r.enabled && isCompleteRow(r));
  if (enabled.length === 0) return {};
  return {
    filter_tree: {
      children: enabled.map((r) => ({
        kind: "condition",
        column: r.column,
        op: r.op,
        value: r.value,
      })),
      combinator: model.combinator,
    },
  };
}

/**
 * A row is "complete" when it has enough data to emit a valid predicate.
 * IS NULL / IS NOT NULL only need a column; In/NotIn need a non-empty array;
 * BETWEEN needs {min, max} both non-empty; everything else needs a non-empty
 * scalar value. Column is always required.
 */
export function isCompleteRow(row: FilterRow): boolean {
  const { column, op, value } = row;
  if (!column) return false;
  if (column.kind === "named" && !column.name) return false;
  if (op === "RAW") return typeof value === "string" && value.trim() !== "";

  if (op === "IS NULL" || op === "IS NOT NULL") return true;

  if (op === "In" || op === "NotIn") {
    if (!Array.isArray(value) || value.length === 0) return false;
    return value.every((v) => v !== "" && v !== null && v !== undefined);
  }

  if (op === "BETWEEN") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return (
      value.min !== "" &&
      value.min !== null &&
      value.min !== undefined &&
      value.max !== "" &&
      value.max !== null &&
      value.max !== undefined
    );
  }

  if (value === "" || value === null || value === undefined) return false;
  return true;
}

/**
 * Structural equality for two filter rows, IGNORING the `enabled` flag.
 * Used for per-row "Applied" badge detection.
 */
export function filterRowEquals(a: FilterRow, b: FilterRow): boolean {
  if (a.op !== b.op) return false;
  if (!columnRefEquals(a.column, b.column)) return false;
  return filterValueEquals(a.value, b.value);
}

/**
 * Structural equality for two filter rows INCLUDING the `enabled` flag.
 * Used by the dirty indicator.
 */
export function filterRowEqualsWithEnabled(a: FilterRow, b: FilterRow): boolean {
  if (a.enabled !== b.enabled) return false;
  return filterRowEquals(a, b);
}

export function filterTreeEquals(a: FilterTree, b: FilterTree): boolean {
  if (a.combinator !== b.combinator) return false;
  if (a.rows.length !== b.rows.length) return false;
  for (let i = 0; i < a.rows.length; i++) {
    if (!filterRowEqualsWithEnabled(a.rows[i]!, b.rows[i]!)) return false;
  }
  return true;
}

export const filterModelEquals = filterTreeEquals;

/**
 * Strip a single leading `WHERE ` (case-insensitive) from a raw body, plus
 * surrounding whitespace. Used by `compilePrefilledSelect` / `compileWhere`.
 */
export function trimLeadingWhere(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  const m = trimmed.match(/^where\s+/i);
  if (m) return trimmed.slice(m[0].length).trim();
  return trimmed;
}

function columnRefEquals(a: ColumnRef, b: ColumnRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "named" && b.kind === "named") return a.name === b.name;
  return true;
}

function filterValueEquals(a: FilterValue | undefined, b: FilterValue | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    return a.min === b.min && a.max === b.max;
  }
  return a === b;
}
