import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";
import type {
  AthenaActiveConnection,
  AthenaColumnInfo,
  AthenaDatabaseInfo,
  AthenaMultiSqlResult,
  AthenaNamedQueryDetail,
  AthenaNamedQuerySummary,
  AthenaParams,
  AthenaRelationInfo,
  AthenaRunSqlResult,
  ProfileInfo,
  TestConnectionResult,
} from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const athenaApi = {
  // ---------------------------------------------------------------------------
  // Test / connect / disconnect
  // ---------------------------------------------------------------------------

  async testConnection(params: AthenaParams, secret?: string): Promise<TestConnectionResult> {
    const raw = await call<unknown>("athena_test_connection", {
      params,
      secret: secret ?? null,
    });
    return raw as TestConnectionResult;
  },

  connect: (id: string) =>
    call<void>("athena_connect", { id }),

  disconnect: (id: string) =>
    call<void>("athena_disconnect", { id }),

  disconnectAll: () =>
    call<number>("athena_disconnect_all"),

  listActive: () =>
    call<AthenaActiveConnection[]>("athena_list_active"),

  // ---------------------------------------------------------------------------
  // SQL execution
  // ---------------------------------------------------------------------------

  runSql: (id: string, sql: string, origin: "auto" | "user" = "user"): Promise<AthenaRunSqlResult> =>
    call<AthenaRunSqlResult>("athena_run_sql", { id, sql, origin }),

  runSqlMany: (
    id: string,
    statements: string[],
    origin: "auto" | "user" = "user",
  ): Promise<AthenaMultiSqlResult> =>
    call<AthenaMultiSqlResult>("athena_run_sql_many", { id, statements, origin }),

  cancelQuery: (id: string, queryExecutionId: string) =>
    call<void>("athena_cancel_query", { id, queryExecutionId }),

  // ---------------------------------------------------------------------------
  // Schema browser (Glue introspection)
  // ---------------------------------------------------------------------------

  listDatabases: (id: string): Promise<AthenaDatabaseInfo[]> =>
    call<AthenaDatabaseInfo[]>("athena_list_databases", { id }),

  listRelations: (id: string, database: string): Promise<AthenaRelationInfo[]> =>
    call<AthenaRelationInfo[]>("athena_list_relations", { id, database }),

  listColumns: (id: string, database: string, relation: string): Promise<AthenaColumnInfo[]> =>
    call<AthenaColumnInfo[]>("athena_list_columns", { id, database, relation }),

  // ---------------------------------------------------------------------------
  // Named queries
  // ---------------------------------------------------------------------------

  listNamedQueries: (id: string): Promise<AthenaNamedQuerySummary[]> =>
    call<AthenaNamedQuerySummary[]>("athena_list_named_queries", { id }),

  getNamedQuery: (id: string, namedQueryId: string): Promise<AthenaNamedQueryDetail> =>
    call<AthenaNamedQueryDetail>("athena_get_named_query", { id, namedQueryId }),

  // ---------------------------------------------------------------------------
  // S3 browse — pick an output-location bucket with the form's credentials
  // ---------------------------------------------------------------------------

  listS3Buckets: (params: AthenaParams, secret?: string): Promise<string[]> =>
    call<string[]>("athena_list_s3_buckets", { params, secret: secret ?? null }),

  listS3Prefixes: (
    params: AthenaParams,
    bucket: string,
    prefix?: string,
    secret?: string,
  ): Promise<{ prefix: string }[]> =>
    call<{ prefix: string }[]>("athena_list_s3_prefixes", {
      params,
      secret: secret ?? null,
      bucket,
      prefix: prefix ?? null,
    }),

  // ---------------------------------------------------------------------------
  // AWS profile listing — reuse the dynamo command (same backend function)
  // ---------------------------------------------------------------------------

  listAwsProfiles: () =>
    call<ProfileInfo[]>("dynamo_list_aws_profiles"),
};
