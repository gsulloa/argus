export type ActivityKind =
  // Connection lifecycle (shared: postgres + mysql + dynamo)
  | "test_connection"
  | "connect"
  | "disconnect"
  | "update_credentials"
  // Schema browser (shared: postgres + mysql)
  | "list_schemas"
  | "list_relations"
  | "list_structure"
  | "list_table_extras"
  | "list_columns_bulk"
  // Data grid (shared: postgres + mysql)
  | "query_table"
  | "count_table"
  | "apply_edits"
  // SQL editor (shared: postgres + mysql)
  | "run_sql"
  | "run_sql_many"
  // Table structure / DDL (shared: postgres + mysql)
  | "table_structure"
  | "table_ddl"
  // DynamoDB-specific
  | "list_tables"
  | "describe_table"
  | "scan_table"
  | "put_item"
  | "update_item"
  | "delete_item";

export type Origin = "auto" | "user";
export type Status = "ok" | "err";

export type Metric =
  | { kind: "rows"; value: number }
  | { kind: "count"; value: number }
  | { kind: "server_version"; value: string }
  | { kind: "items"; value: number };

export interface ActivityError {
  message: string;
  code: string | null;
}

export interface ActivityLogEntry {
  v: number;
  id: string;
  timestamp_unix_ms: number;
  connection_id: string | null;
  kind: ActivityKind;
  origin: Origin;
  duration_ms: number;
  status: Status;
  sql: string | null;
  params: string[] | null;
  metric: Metric | null;
  error: ActivityError | null;
}

export const ACTIVITY_LOG_EVENT = "argus:activity-log";
export const ACTIVITY_LOG_CAPACITY = 1000;
