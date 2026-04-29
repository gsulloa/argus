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

/**
 * Filter predicate accepted by `postgres_query_table` and `postgres_count_table`.
 * Mirrors the closed Rust enum 1:1.
 */
export type Filter =
  | { op: "="; column: string; value: FilterValue }
  | { op: "!="; column: string; value: FilterValue }
  | { op: "<"; column: string; value: FilterValue }
  | { op: "<="; column: string; value: FilterValue }
  | { op: ">"; column: string; value: FilterValue }
  | { op: ">="; column: string; value: FilterValue }
  | { op: "LIKE"; column: string; value: FilterValue }
  | { op: "NOT LIKE"; column: string; value: FilterValue }
  | { op: "IS NULL"; column: string }
  | { op: "IS NOT NULL"; column: string }
  | { op: "BETWEEN"; column: string; min: FilterValue; max: FilterValue };

/**
 * Values that can be bound as a filter parameter. The backend rejects null —
 * IS NULL / IS NOT NULL are dedicated ops.
 */
export type FilterValue = string | number | boolean;

export interface QueryTableOptions {
  limit: number;
  offset: number;
  order_by?: OrderBy[];
  filters?: Filter[];
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
    filters: Filter[];
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
