import type { AppError } from "@/platform/errors/AppError";

// ---------------------------------------------------------------------------
// Kind constant
// ---------------------------------------------------------------------------

export const CLOUDWATCH_KIND = "cloudwatch" as const;

// ---------------------------------------------------------------------------
// Connection params
// ---------------------------------------------------------------------------

export type CloudwatchAuth = "profile" | "access_keys";

export interface CloudwatchParams {
  region: string;
  auth: CloudwatchAuth;
  profile?: string;
}

// ---------------------------------------------------------------------------
// Connection lifecycle types
// ---------------------------------------------------------------------------

export interface CloudwatchActiveConnection {
  id: string;
  region: string;
  account_id: string;
  identity_arn: string;
  connected_at_unix_ms: number;
}

export type TestConnectionResult =
  | { ok: true; latencyMs: number; accountId: string; identityArn: string; region: string }
  | { ok: false; error: AppError };

// ---------------------------------------------------------------------------
// Log group / stream / event types
// ---------------------------------------------------------------------------

export interface LogGroupItem {
  name: string;
  arn: string;
  stored_bytes?: number | null;
  retention_in_days?: number | null;
}

export interface ListLogGroupsResponse {
  groups: LogGroupItem[];
  next_token?: string | null;
}

export interface LogStreamItem {
  name: string;
  last_event_ts?: number | null;
  first_event_ts?: number | null;
  stored_bytes?: number | null;
}

export interface ListLogStreamsResponse {
  streams: LogStreamItem[];
  next_token?: string | null;
}

export interface LogEventItem {
  ts?: number | null;
  ingestion_ts?: number | null;
  message: string;
}

export interface GetLogEventsResponse {
  events: LogEventItem[];
  next_forward_token?: string | null;
  next_backward_token?: string | null;
}

// ---------------------------------------------------------------------------
// Insights result types
// ---------------------------------------------------------------------------

export interface InsightsColumnInfo {
  name: string;
  /** Always "string" for CloudWatch Insights results. */
  type: string;
}

export interface InsightsResultRows {
  kind: "rows";
  columns: InsightsColumnInfo[];
  rows: unknown[][];
  query_ms: number;
  truncated: boolean;
  records_matched: number;
  records_scanned: number;
  bytes_scanned: number;
}

export type InsightsResult = InsightsResultRows;

// ---------------------------------------------------------------------------
// Profile info (shared shape with DynamoDB/Athena)
// ---------------------------------------------------------------------------

export interface ProfileInfo {
  name: string;
  sso: boolean;
  region?: string;
}

// ---------------------------------------------------------------------------
// Time range picker types
// ---------------------------------------------------------------------------

export type RelativePreset = "5m" | "15m" | "1h" | "3h" | "12h" | "1d" | "1w";

export interface AbsoluteRange {
  kind: "absolute";
  startEpochS: number;
  endEpochS: number;
}

export interface RelativeRange {
  kind: "relative";
  preset: RelativePreset;
}

export type TimeRange = AbsoluteRange | RelativeRange;
