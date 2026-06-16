export interface SchemaSummary {
  name: string;
  owner: string | null;
  is_system: boolean;
  comment: string | null;
}

export type TableKind = "regular" | "partitioned" | "foreign";

export interface TableInfo {
  name: string;
  owner: string | null;
  estimated_rows: number | null;
  comment: string | null;
  kind: TableKind;
}

export interface ViewInfo {
  name: string;
  owner: string | null;
  comment: string | null;
}

/**
 * Lightweight function entry returned by `listStructure`. The expensive
 * `pg_get_function_arguments` lookup is deferred to `getFunctionSignature`.
 */
export interface FunctionInfo {
  name: string;
  oid: number;
  language: string;
  comment: string | null;
}

export type TypeKind = "composite" | "enum" | "domain" | "range";

export interface TypeInfo {
  name: string;
  kind: TypeKind;
  comment: string | null;
}

export interface ExtensionInfo {
  name: string;
  version: string;
  comment: string | null;
}

export interface IndexInfo {
  name: string;
  table: string;
  is_unique: boolean;
  is_primary: boolean;
  method: string;
}

export type TriggerTiming = "before" | "after" | "instead_of";
export type TriggerEvent = "insert" | "update" | "delete" | "truncate";

export interface TriggerInfo {
  name: string;
  table: string;
  timing: TriggerTiming;
  events: TriggerEvent[];
  function: string;
}

/**
 * Per-kind failure entry inside a partial-degradation envelope. Permission-
 * denied is collapsed to an empty kind upstream and never surfaces as a
 * failure — only timeouts and other errors reach this shape.
 */
export interface KindFailure {
  kind: string;
  code: string | null;
  message: string;
}

/**
 * Eager schema fetch — single underlying query. No partial-result envelope.
 */
export interface RelationsResult {
  schema: string;
  tables: TableInfo[];
  views: ViewInfo[];
  materialized_views: ViewInfo[];
}

/**
 * Lazy structure fetch. Each of `functions`, `types`, `extensions` is `null`
 * when the corresponding sub-query failed (a `KindFailure` entry is in
 * `failures`). Permission-denied collapses to `[]` (not `null`).
 */
export interface StructureResult {
  schema: string;
  functions: FunctionInfo[] | null;
  types: TypeInfo[] | null;
  extensions: ExtensionInfo[] | null;
  failures: KindFailure[];
}

/**
 * Lazy per-table fetch. Same partial-degradation semantics as
 * `StructureResult`, scoped to a single relation.
 */
export interface TableExtrasResult {
  schema: string;
  relation: string;
  indexes: IndexInfo[] | null;
  triggers: TriggerInfo[] | null;
  failures: KindFailure[];
}

export interface FunctionSignature {
  args_signature: string;
  return_type: string | null;
}

export type Relkind = "table" | "view" | "materialized-view";

export type FkAction =
  | "no_action"
  | "restrict"
  | "cascade"
  | "set_null"
  | "set_default";

export interface ColumnDetail {
  name: string;
  data_type: string;
  is_nullable: boolean;
  default: string | null;
  ordinal_position: number;
  comment: string | null;
  is_identity: boolean;
  is_generated: boolean;
}

export interface PrimaryKeyInfo {
  name: string;
  columns: string[];
}

export interface ForeignKeyRef {
  schema: string;
  relation: string;
  columns: string[];
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  references: ForeignKeyRef;
  on_update: FkAction;
  on_delete: FkAction;
  deferrable: boolean;
  initially_deferred: boolean;
}

export interface UniqueConstraintInfo {
  name: string;
  columns: string[];
}

export interface CheckConstraintInfo {
  name: string;
  expression: string;
}

/**
 * Single round-trip for the Structure / Raw subtab. `columns` is always
 * populated (a failure on the columns sub-query becomes a hard error rather
 * than a partial response); every other section follows the same partial-
 * degradation envelope as `TableExtrasResult` (`null` + a `failures` entry on
 * non-permission failures, `[]` / `null` PK on permission-denied).
 */
export interface TableStructureResult {
  schema: string;
  relation: string;
  relkind: Relkind;
  is_best_effort: boolean;
  columns: ColumnDetail[];
  primary_key: PrimaryKeyInfo | null;
  foreign_keys: ForeignKeyInfo[] | null;
  unique_constraints: UniqueConstraintInfo[] | null;
  check_constraints: CheckConstraintInfo[] | null;
  indexes: IndexInfo[] | null;
  triggers: TriggerInfo[] | null;
  ddl: string;
  failures: KindFailure[];
}

/** Discriminator for tab payloads and search labels. */
export type ObjectKind =
  | "table"
  | "view"
  | "materialized_view"
  | "function"
  | "type"
  | "extension"
  | "index"
  | "trigger";
