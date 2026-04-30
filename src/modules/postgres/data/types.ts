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
  | "IS NOT NULL";

/** Either a named column or the special "Any column" pseudo-column. */
export type ColumnRef =
  | { kind: "named"; name: string }
  | { kind: "any_column" };

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
 * One node of the filter tree. Internally tagged with `kind`. The wire
 * shape mirrors the Rust `FilterNode` enum — `or_group` carries
 * `FilterNode[]` so the JSON shape is uniform; the backend rejects nested
 * `or_group` at validation time and the UI doesn't allow it.
 */
export type FilterNode =
  | ({ kind: "condition" } & Condition)
  | { kind: "or_group"; children: FilterNode[] };

export interface FilterTree {
  children: FilterNode[];
}

export type FilterMode = "structured" | "raw";

/**
 * UI-level filter state. Carries both modes simultaneously so the user can
 * toggle between Structured and Raw without losing draft state. When
 * dispatching to the backend, exactly one of `filter_tree` / `raw_where`
 * is emitted based on `mode` (and `raw` is sent only if non-empty after
 * trimming a leading `WHERE`).
 */
export interface FilterModel {
  mode: FilterMode;
  tree: FilterTree;
  raw: string;
}

export const EMPTY_FILTER_TREE: FilterTree = { children: [] };

export const EMPTY_FILTER_MODEL: FilterModel = {
  mode: "structured",
  tree: EMPTY_FILTER_TREE,
  raw: "",
};

export interface QueryTableOptions {
  limit: number;
  offset: number;
  order_by?: OrderBy[];
  filter_tree?: FilterTree;
  raw_where?: string;
}

export interface CountTableOptions {
  filter_tree?: FilterTree;
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
    filter_tree: FilterTree | null;
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
// FilterModel helpers
// --------------------------------------------------------------------------

/**
 * Project a UI-level `FilterModel` to the wire payload accepted by
 * `postgres_query_table` / `postgres_count_table`. Exactly one of
 * `filter_tree` / `raw_where` is emitted (both undefined means "no WHERE").
 */
export function modelToPayload(model: FilterModel): {
  filter_tree?: FilterTree;
  raw_where?: string;
} {
  if (model.mode === "raw") {
    const trimmed = trimLeadingWhere(model.raw);
    if (trimmed.length === 0) return {};
    return { raw_where: trimmed };
  }
  if (model.tree.children.length === 0) return {};
  return { filter_tree: model.tree };
}

/**
 * Strip a single leading `WHERE ` (case-insensitive) from a raw body, plus
 * surrounding whitespace. Mirrors the backend's tolerant trimming so the
 * user can keep or drop the keyword without surprises.
 */
export function trimLeadingWhere(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  const m = trimmed.match(/^where\s+/i);
  if (m) return trimmed.slice(m[0].length).trim();
  return trimmed;
}

/** Structural equality for FilterModel — used by the dirty indicator. */
export function filterModelEquals(a: FilterModel, b: FilterModel): boolean {
  if (a.mode !== b.mode) return false;
  if (a.raw !== b.raw) return false;
  return filterTreeEquals(a.tree, b.tree);
}

export function filterTreeEquals(a: FilterTree, b: FilterTree): boolean {
  if (a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i++) {
    if (!filterNodeEquals(a.children[i]!, b.children[i]!)) return false;
  }
  return true;
}

function filterNodeEquals(a: FilterNode, b: FilterNode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "condition" && b.kind === "condition") {
    return conditionEquals(a, b);
  }
  if (a.kind === "or_group" && b.kind === "or_group") {
    if (a.children.length !== b.children.length) return false;
    for (let i = 0; i < a.children.length; i++) {
      if (!filterNodeEquals(a.children[i]!, b.children[i]!)) return false;
    }
    return true;
  }
  return false;
}

function conditionEquals(a: Condition, b: Condition): boolean {
  if (a.op !== b.op) return false;
  if (!columnRefEquals(a.column, b.column)) return false;
  return filterValueEquals(a.value, b.value);
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
