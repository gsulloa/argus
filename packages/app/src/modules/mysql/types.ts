import type { AppError } from "@/platform/errors/AppError";

// ---------------------------------------------------------------------------
// Connection params & SSL mode
// ---------------------------------------------------------------------------

export type SslMode =
  | "disabled"
  | "preferred"
  | "required"
  | "verify-ca"
  | "verify-identity";

export const SSL_MODES: SslMode[] = [
  "disabled",
  "preferred",
  "required",
  "verify-ca",
  "verify-identity",
];

export interface MysqlParams {
  host: string;
  port: number;
  database: string;
  username: string;
  ssl_mode: SslMode;
  read_only: boolean;
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
  read_only: boolean;
  connected_at_unix_ms: number;
}

export interface ConnectResult {
  server_version: string;
  read_only: boolean;
}

export interface ParseUrlResult {
  params: MysqlParams;
  password: string | null;
}

export interface TestConnectionResult {
  ok: boolean;
  latency_ms?: number;
  server_version?: string;
  error?: { kind: string; message: unknown };
}

// ---------------------------------------------------------------------------
// Schema browser types (mirror of Postgres schema types adapted for MySQL)
// ---------------------------------------------------------------------------

export interface SchemaInfo {
  name: string;
  is_system: boolean;
}

export type RelationKind = "table" | "view" | "partitioned";

export interface RelationInfo {
  name: string;
  kind: RelationKind;
  estimated_rows: number | null;
}

export interface ViewInfo {
  name: string;
}

export interface RelationsResult {
  schema: string;
  tables: RelationInfo[];
  views: ViewInfo[];
}

/** Routine kind: procedure or function */
export type RoutineKind = "procedure" | "function";

export interface RoutineInfo {
  name: string;
  kind: RoutineKind;
}

export interface TriggerInfo {
  name: string;
  table: string;
  timing: string;
  events: string[];
}

export interface EventInfo {
  name: string;
  status: string;
}

export interface KindFailure {
  kind: string;
  code: string | null;
  message: string;
}

export interface StructureResult {
  schema: string;
  routines: RoutineInfo[] | null;
  triggers: TriggerInfo[] | null;
  events: EventInfo[] | null;
  failures: KindFailure[];
}

export interface IndexColumn {
  name: string;
  sub_part: number | null;
  descending: boolean;
}

export interface IndexInfo {
  name: string;
  is_unique: boolean;
  is_primary: boolean;
  columns: IndexColumn[];
  index_type: string;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  ref_schema: string;
  ref_table: string;
  ref_columns: string[];
  on_update: string;
  on_delete: string;
}

export interface TableExtrasResult {
  schema: string;
  relation: string;
  indexes: IndexInfo[] | null;
  triggers: TriggerInfo[] | null;
  foreign_keys: ForeignKeyInfo[] | null;
  failures: KindFailure[];
}

export interface RoutineSignature {
  parameters: RoutineParameter[];
  returns: string | null;
}

export interface RoutineParameter {
  name: string | null;
  data_type: string;
  mode: string;
}

// ---------------------------------------------------------------------------
// Data grid types
// ---------------------------------------------------------------------------

export interface ColumnInfo {
  name: string;
  data_type: string;
  column_type: string;
  ordinal_position: number;
  is_nullable: boolean;
  column_default: string | null;
  extra: string | null;
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

export interface EditError {
  code: string | null;
  message: string;
  failed_op_index: number;
}

export interface RefreshedRow {
  pk: Record<string, EditValue>;
  row: unknown[] | null;
}

export type ApplyEditsResult =
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

export interface PrimaryKey {
  columns: string[];
  auto_increment_column: string | null;
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
    code: string | null;
    position: number | null;
  };
}

export type MultiSqlResult = StatementOutcome[];

// ---------------------------------------------------------------------------
// Table structure types
// ---------------------------------------------------------------------------

export interface TableStructureColumn {
  name: string;
  data_type: string;
  column_type: string;
  is_nullable: boolean;
  column_default: string | null;
  extra: string | null;
  ordinal_position: number;
}

export interface UniqueConstraint {
  name: string;
  columns: string[];
}

export interface TableForeignKey {
  name: string;
  columns: string[];
  ref_schema: string;
  ref_table: string;
  ref_columns: string[];
  on_update: string;
  on_delete: string;
}

export interface TableIndex {
  name: string;
  is_unique: boolean;
  is_primary: boolean;
  columns: IndexColumn[];
  index_type: string;
}

export interface TableTrigger {
  name: string;
  timing: string;
  events: string[];
}

export interface TableOptions {
  engine: string | null;
  row_format: string | null;
  charset: string | null;
  collation: string | null;
  comment: string | null;
  auto_increment: number | null;
}

export interface TableStructureResult {
  schema: string;
  relation: string;
  columns: TableStructureColumn[];
  primary_key: PrimaryKey | null;
  unique_constraints: UniqueConstraint[] | null;
  foreign_keys: TableForeignKey[] | null;
  indexes: TableIndex[] | null;
  triggers: TableTrigger[] | null;
  table_options: TableOptions | null;
  failures: KindFailure[];
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
  column_type: string;
  ordinal_position: number;
  is_nullable: boolean;
}

export interface ColumnsBulkResult {
  schema: string;
  columns_by_relation: Record<string, BulkColumn[]>;
}

// ---------------------------------------------------------------------------
// Kind constant
// ---------------------------------------------------------------------------

export const MYSQL_KIND = "mysql" as const;
