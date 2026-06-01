import type { AppError } from "@/platform/errors/AppError";

// ---------------------------------------------------------------------------
// Kind constant
// ---------------------------------------------------------------------------

export const MSSQL_KIND = "mssql" as const;

// ---------------------------------------------------------------------------
// Connection params
// ---------------------------------------------------------------------------

export type EncryptMode = "off" | "on" | "strict";
export type ApplicationIntent = "read-write" | "read-only";

export const ENCRYPT_MODES: EncryptMode[] = ["off", "on", "strict"];
export const APPLICATION_INTENTS: ApplicationIntent[] = ["read-write", "read-only"];

export interface MssqlParams {
  host: string;
  port: number;
  database: string;
  username: string;
  encrypt: EncryptMode;
  trustServerCertificate: boolean;
  readOnly: boolean;
  instanceName?: string | null;
  applicationIntent?: ApplicationIntent | null;
}

// ---------------------------------------------------------------------------
// Connection lifecycle types
// ---------------------------------------------------------------------------

export type TestResult =
  | { ok: true; latencyMs: number; serverVersion: string }
  | { ok: false; error: AppError };

export interface ActiveConnection {
  id: string;
  server_version: string;
  product_version: string;
  engine_edition: number;
  encrypt_mode: EncryptMode;
  read_only: boolean;
  connected_at_unix_ms: number;
}

export interface ConnectResult {
  server_version: string;
  product_version: string;
  engine_edition: number;
  encrypt_mode: EncryptMode;
  read_only: boolean;
}

export interface TestConnectionResult {
  ok: boolean;
  server_version?: string;
  latency_ms?: number;
  error?: { kind: string; message: unknown };
}

export interface ParseUrlResult {
  params: MssqlParams;
  password: string | null;
}

// ---------------------------------------------------------------------------
// Schema browser types
// ---------------------------------------------------------------------------

export interface SchemaInfo {
  name: string;
  is_system: boolean;
}

export interface DatabaseInfo {
  name: string;
}

export type RelationKind = "table" | "view" | "indexed_view" | "partitioned";

export interface RelationInfo {
  name: string;
  kind: RelationKind;
  estimated_rows: number | null;
}

export interface RelationsResult {
  schema: string;
  tables: RelationInfo[];
  views: RelationInfo[];
}

export type RoutineKind = "procedure" | "function" | "trigger" | "sequence";

export interface RoutineInfo {
  name: string;
  kind: RoutineKind;
  function_type?: string | null;
}

export interface TriggerInfo {
  name: string;
  table: string | null;
  timing: string;
  events: string[];
}

export interface SequenceInfo {
  name: string;
  data_type: string;
  start_value: string;
  increment: string;
}

export interface KindFailure {
  kind: string;
  code: number | null;
  message: string;
}

export interface StructureResult {
  schema: string;
  procedures: RoutineInfo[] | null;
  functions: RoutineInfo[] | null;
  triggers: TriggerInfo[] | null;
  sequences: SequenceInfo[] | null;
  failures: KindFailure[];
}

export interface IndexColumn {
  name: string;
  descending: boolean;
}

export interface IndexInfo {
  name: string;
  is_unique: boolean;
  is_primary: boolean;
  is_clustered: boolean;
  columns: IndexColumn[];
  included_columns: string[];
  filter_predicate: string | null;
  index_type: string;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  ref_schema: string;
  ref_table: string;
  ref_columns: string[];
  on_delete: string;
  on_update: string;
  is_disabled: boolean;
  is_not_trusted: boolean;
}

export interface CheckConstraintInfo {
  name: string;
  column: string | null;
  definition: string;
}

export interface DefaultConstraintInfo {
  name: string;
  column: string;
  definition: string;
}

export interface TableExtrasResult {
  schema: string;
  relation: string;
  indexes: IndexInfo[] | null;
  triggers: TriggerInfo[] | null;
  foreign_keys: ForeignKeyInfo[] | null;
  check_constraints: CheckConstraintInfo[] | null;
  default_constraints: DefaultConstraintInfo[] | null;
  failures: KindFailure[];
}

export interface RoutineParameter {
  name: string | null;
  data_type: string;
  mode: string;
}

export interface RoutineSignature {
  parameters: RoutineParameter[];
  returns: string | null;
}

// ---------------------------------------------------------------------------
// Data grid types
// ---------------------------------------------------------------------------

export interface ColumnInfo {
  name: string;
  data_type: string;
  base_type: string;
  ordinal_position: number;
  is_nullable: boolean;
  column_default: string | null;
  is_identity: boolean;
  is_computed: boolean;
  character_max_length: number | null;
}

export type Direction = "asc" | "desc";

export interface OrderBy {
  column: string;
  direction: Direction;
}

export type Operator =
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "LIKE"
  | "NOT LIKE"
  | "Contains"
  | "StartsWith"
  | "EndsWith"
  | "In"
  | "NotIn"
  | "BETWEEN"
  | "IS NULL"
  | "IS NOT NULL";

export type ColumnRef =
  | { kind: "named"; name: string }
  | { kind: "any_column" };

export type FilterScalar = string | number | boolean;

export type FilterValue =
  | FilterScalar
  | FilterScalar[]
  | { min: FilterScalar; max: FilterScalar };

export interface Condition {
  column: ColumnRef;
  op: Operator;
  value?: FilterValue;
}

export interface FilterRow {
  enabled: boolean;
  column: ColumnRef;
  op: Operator;
  value?: FilterValue;
}

export interface FilterNode {
  kind: "condition";
  column: ColumnRef;
  op: Operator;
  value?: FilterValue;
}

export type RootCombinator = "AND" | "OR";

export interface QueryOptions {
  limit: number;
  offset: number;
  order_by?: OrderBy[];
  filter_tree?: { children: FilterNode[]; combinator: RootCombinator };
}

export interface QueryResult {
  columns: ColumnInfo[];
  rows: unknown[][];
  applied: {
    limit: number;
    offset: number;
    order_by: OrderBy[];
    filter_tree: { children: FilterNode[]; combinator: RootCombinator } | null;
  };
  query_ms: number;
  truncated_columns: string[];
}

export interface CountResult {
  count: number;
  approximate: boolean;
  query_ms: number;
}

export type Filter = FilterRow;

// ---------------------------------------------------------------------------
// Edit types
// ---------------------------------------------------------------------------

export type EditValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: unknown }
  | unknown[];

export type EditOp =
  | { kind: "update"; pk: Record<string, EditValue>; changes: Record<string, EditValue> }
  | { kind: "insert"; values: Record<string, EditValue> }
  | { kind: "delete"; pk: Record<string, EditValue> };

export interface RefreshedRow {
  pk: Record<string, EditValue>;
  row: unknown[] | null;
}

/**
 * Successful result from `mssql_apply_table_edits`.
 *
 * The MSSQL backend always returns success here; op-level failures are thrown
 * as AppError (caught by the invoke wrapper). The `degraded_to_refetch` field
 * is true when the table has enabled triggers that prevented the OUTPUT clause
 * from being used — the rows were re-fetched via SELECT instead.
 */
export interface ApplyEditsResult {
  refreshed_rows: RefreshedRow[];
  columns: Array<{ name: string; data_type: string; base_type: string; is_nullable: boolean; is_identity: boolean; is_computed: boolean; ordinal_position: number; column_default: string | null; character_max_length: number | null }>;
  degraded_to_refetch: boolean;
  applied_ms: number;
}

export interface PrimaryKey {
  columns: string[];
  identity_column: string | null;
}

export type PrimaryKeyResult = PrimaryKey;

// ---------------------------------------------------------------------------
// SQL editor types
// ---------------------------------------------------------------------------

export type RunSqlResult =
  | {
      kind: "rows";
      columns: ColumnInfo[];
      rows: unknown[][];
      truncated_columns: string[];
      truncated: boolean;
      query_ms: number;
    }
  | {
      kind: "affected";
      command_tag: string;
      affected_rows: number;
      query_ms: number;
    };

export interface StatementOutcome {
  statement_index: number;
  outcome: "ok" | "err" | "skipped";
  result?: RunSqlResult;
  error?: {
    message: string;
    code: number | null;
    line: number | null;
    procedure: string | null;
  };
}

export type MultiSqlResult = StatementOutcome[];

// ---------------------------------------------------------------------------
// Table structure types
// ---------------------------------------------------------------------------

export interface TableStructureColumn {
  name: string;
  data_type: string;
  base_type: string;
  is_nullable: boolean;
  column_default: string | null;
  ordinal_position: number;
  is_identity: boolean;
  identity_seed: string | null;
  identity_increment: string | null;
  is_computed: boolean;
  computed_expression: string | null;
  is_persisted: boolean;
  is_sparse: boolean;
  category: string | null;
}

export interface UniqueConstraint {
  name: string;
  columns: string[];
}

export interface TableStructureResult {
  schema: string;
  relation: string;
  columns: TableStructureColumn[];
  primary_key: PrimaryKey | null;
  unique_constraints: UniqueConstraint[] | null;
  foreign_keys: ForeignKeyInfo[] | null;
  indexes: IndexInfo[] | null;
  triggers: TriggerInfo[] | null;
  check_constraints: CheckConstraintInfo[] | null;
  default_constraints: DefaultConstraintInfo[] | null;
  table_options: TableOptions | null;
  failures: KindFailure[];
}

export interface TableOptions {
  is_memory_optimized: boolean;
  temporal_type: string | null;
  lock_escalation: string | null;
}

export interface TableDdlResult {
  ddl: string;
}

// ---------------------------------------------------------------------------
// Bulk columns cache types
// ---------------------------------------------------------------------------

export interface BulkColumn {
  name: string;
  data_type: string;
  base_type: string;
  ordinal_position: number;
  is_nullable: boolean;
  is_identity: boolean;
  is_computed: boolean;
  column_default: string | null;
  character_max_length: number | null;
  comment: string | null;
}

export interface ColumnsBulkResult {
  schema: string;
  columns_by_relation: Record<string, BulkColumn[]>;
}
