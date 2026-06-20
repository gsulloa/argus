import type { AppError } from "@/platform/errors/AppError";

// ---------------------------------------------------------------------------
// Kind constant
// ---------------------------------------------------------------------------

export const ATHENA_KIND = "athena" as const;

// ---------------------------------------------------------------------------
// Connection params
// ---------------------------------------------------------------------------

export type AthenaAuth = "profile" | "access_keys";

export interface AthenaParams {
  region: string;
  workgroup: string;
  output_location?: string;
  auth: AthenaAuth;
  profile?: string;
  read_only: boolean;
}

// ---------------------------------------------------------------------------
// Connection lifecycle types
// ---------------------------------------------------------------------------

export interface AthenaActiveConnection {
  id: string;
  region: string;
  account_id: string;
  read_only: boolean;
  connected_at_unix_ms: number;
}

export type TestConnectionResult =
  | { ok: true; latencyMs: number; accountId: string }
  | { ok: false; error: AppError };

// ---------------------------------------------------------------------------
// Schema browser types
// ---------------------------------------------------------------------------

export interface AthenaDatabaseInfo {
  name: string;
}

export type AthenaRelationKind = "table" | "view";

export interface AthenaRelationInfo {
  name: string;
  kind: AthenaRelationKind;
}

export interface AthenaColumnInfo {
  name: string;
  ty: string;
}

// ---------------------------------------------------------------------------
// SQL editor types
// ---------------------------------------------------------------------------

/** ColumnInfo as returned by Athena result-set metadata. */
export interface AthenaResultColumnInfo {
  name: string;
  /** Athena/Presto type string e.g. "varchar", "bigint", "boolean". */
  ty: string;
}

/**
 * Result from athena_run_sql.
 *
 * Two variants:
 *  - "rows"      → SELECT produced a result set
 *  - "succeeded" → DDL/DML with no result set (CREATE, INSERT, etc.)
 */
export type AthenaRunSqlResult =
  | {
      kind: "rows";
      columns: AthenaResultColumnInfo[];
      rows: unknown[][];
      query_ms: number;
      truncated: boolean;
      data_scanned_bytes: number;
    }
  | {
      kind: "succeeded";
      statement_type: string;
      query_ms: number;
      data_scanned_bytes: number;
    };

export interface AthenaStatementOutcome {
  statement_index: number;
  outcome: "ok" | "err" | "skipped";
  result?: AthenaRunSqlResult;
  error?: {
    message: string;
    code: string | null;
    position: number | null;
  };
}

export type AthenaMultiSqlResult = AthenaStatementOutcome[];

// ---------------------------------------------------------------------------
// Named query types
// ---------------------------------------------------------------------------

export interface AthenaNamedQuerySummary {
  named_query_id: string;
  name: string;
  description: string | null;
  database: string;
  work_group: string;
}

export interface AthenaNamedQueryDetail extends AthenaNamedQuerySummary {
  query_string: string;
}

/** Identity returned by athena_create_named_query. */
export interface AthenaCreatedNamedQuery {
  named_query_id: string;
  work_group: string;
  database: string;
}

// Request types for write operations.

export interface AthenaCreateNamedQueryArgs {
  /** Connection id */
  id: string;
  name: string;
  queryString: string;
  database: string;
  workGroup: string;
  description?: string;
}

export interface AthenaUpdateNamedQueryArgs {
  /** Connection id */
  id: string;
  namedQueryId: string;
  name: string;
  queryString: string;
  description?: string;
}

export interface AthenaDeleteNamedQueryArgs {
  /** Connection id */
  id: string;
  namedQueryId: string;
}

// ---------------------------------------------------------------------------
// AWS credentials (shared with DynamoDB keychain shape)
// ---------------------------------------------------------------------------

export interface AwsCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

// ---------------------------------------------------------------------------
// Profile info (shared shape with DynamoDB)
// ---------------------------------------------------------------------------

export interface ProfileInfo {
  name: string;
  sso: boolean;
  region?: string;
}
