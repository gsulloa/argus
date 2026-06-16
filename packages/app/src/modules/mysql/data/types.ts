/**
 * MySQL data-grid types. Most are re-exported from the parent types.ts which
 * already has the MySQL-adapted shapes. This file adds a few local helpers
 * and aliases matching the Postgres data/types.ts contract so the grid
 * components can use the same names.
 */

export type {
  ColumnInfo as DataColumn,
  OrderBy,
  Operator,
  FilterNode,
  FilterRow,
  FilterValue,
  FilterScalar,
  ColumnRef,
  QueryOptions,
  QueryResult,
  CountResult,
  EditValue,
  EditOp,
  RefreshedRow,
  ApplyEditsResult,
  PrimaryKey,
  PrimaryKeyResult,
} from "../types";

// ---------------------------------------------------------------------------
// Filter model (in-memory UI model; mirrors Postgres shape but no ILIKE)
// ---------------------------------------------------------------------------

export interface FilterTree {
  rows: import("../types").FilterRow[];
  combinator: "AND" | "OR";
}

export type FilterModel = FilterTree;

export const EMPTY_FILTER_ROW: import("../types").FilterRow = {
  enabled: true,
  column: { kind: "any_column" },
  op: "Contains",
  value: "",
};

export const EMPTY_FILTER_TREE: FilterTree = { rows: [], combinator: "AND" };
export const EMPTY_FILTER_MODEL: FilterModel = EMPTY_FILTER_TREE;

// ---------------------------------------------------------------------------
// Cell value types
// ---------------------------------------------------------------------------

/**
 * Cell envelope for binary / truncated values from the MySQL backend.
 * Mirrors the Postgres CellEnvelope shape.
 */
export interface CellEnvelope {
  kind: "binary" | "truncated";
  preview: string;
  byte_length: number;
}

export type CellValue =
  | string
  | number
  | boolean
  | null
  | CellEnvelope
  | unknown[]
  | Record<string, unknown>;

export function isCellEnvelope(v: unknown): v is CellEnvelope {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    (o.kind === "binary" || o.kind === "truncated") &&
    typeof o.preview === "string" &&
    typeof o.byte_length === "number"
  );
}

/** Relation kinds supported by the MySQL data viewer. */
export type RelationKind = "table" | "view";

// ---------------------------------------------------------------------------
// Wire model helpers
// ---------------------------------------------------------------------------

export type WireCondition = import("../types").FilterNode;

/**
 * Project a UI FilterModel to the wire payload shape.
 */
export function modelToPayload(model: FilterModel): {
  filter_tree?: { children: WireCondition[]; combinator: "AND" | "OR" };
} {
  const enabled = model.rows.filter((r) => r.enabled && isCompleteRow(r));
  if (enabled.length === 0) return {};
  return {
    filter_tree: {
      children: enabled.map((r) => ({
        kind: "condition" as const,
        column: r.column,
        op: r.op,
        value: r.value,
      })),
      combinator: model.combinator,
    },
  };
}

export function isCompleteRow(row: import("../types").FilterRow): boolean {
  const { column, op, value } = row;
  if (!column) return false;
  if (column.kind === "named" && !column.name) return false;
  if (op === "IS NULL" || op === "IS NOT NULL") return true;
  if (op === "In" || op === "NotIn") {
    if (!Array.isArray(value) || value.length === 0) return false;
    return value.every((v) => v !== "" && v !== null && v !== undefined);
  }
  if (op === "BETWEEN") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const bv = value as { min: unknown; max: unknown };
    return (
      bv.min !== "" && bv.min !== null && bv.min !== undefined &&
      bv.max !== "" && bv.max !== null && bv.max !== undefined
    );
  }
  if (value === "" || value === null || value === undefined) return false;
  return true;
}
