export type ActivityKind =
  | "test_connection"
  | "connect"
  | "disconnect"
  | "list_schemas"
  | "list_relations"
  | "list_structure"
  | "list_table_extras"
  | "query_table"
  | "count_table"
  | "apply_edits";

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
