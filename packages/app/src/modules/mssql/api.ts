import { invoke } from "@tauri-apps/api/core";
import { toAppError, AppError } from "@/platform/errors/AppError";
import type {
  ActiveConnection,
  ApplyEditsResult,
  ColumnsBulkResult,
  ConnectResult,
  CountResult,
  DatabaseInfo,
  EditOp,
  MssqlParams,
  MultiSqlResult,
  ParseUrlResult,
  PrimaryKeyResult,
  QueryOptions,
  QueryResult,
  RelationsResult,
  RoutineSignature,
  RunSqlResult,
  SchemaInfo,
  StructureResult,
  TableDdlResult,
  TableExtrasResult,
  TableStructureResult,
  TestConnectionResult,
  TestResult,
} from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const mssqlApi = {
  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  async testConnection(params: MssqlParams, secret?: string | null): Promise<TestResult> {
    const raw = await call<TestConnectionResult>("mssql_test_connection", {
      params,
      secret: secret ?? null,
    });
    if (raw.ok && typeof raw.latency_ms === "number" && typeof raw.server_version === "string") {
      return { ok: true, latencyMs: raw.latency_ms, serverVersion: raw.server_version };
    }
    const err = toAppError(raw.error ?? { kind: "Internal", message: "test failed" });
    return { ok: false, error: err };
  },

  connect: (id: string): Promise<ConnectResult> =>
    call<ConnectResult>("mssql_connect", { id }),

  disconnect: (id: string): Promise<void> =>
    call<void>("mssql_disconnect", { id }),

  disconnectAll: (): Promise<number> =>
    call<number>("mssql_disconnect_all"),

  listActive: (): Promise<ActiveConnection[]> =>
    call<ActiveConnection[]>("mssql_list_active"),

  parseUrl: (input: string): Promise<ParseUrlResult> =>
    call<ParseUrlResult>("mssql_parse_url", { input }),

  // ---------------------------------------------------------------------------
  // Schema browser
  // ---------------------------------------------------------------------------

  listSchemas: (id: string): Promise<SchemaInfo[]> =>
    call<SchemaInfo[]>("mssql_list_schemas", { id }),

  listDatabases: (id: string): Promise<DatabaseInfo[]> =>
    call<DatabaseInfo[]>("mssql_list_databases", { id }),

  listRelations: (id: string, schema: string): Promise<RelationsResult> =>
    call<RelationsResult>("mssql_list_relations", { id, schema }),

  listStructure: (id: string, schema: string): Promise<StructureResult> =>
    call<StructureResult>("mssql_list_structure", { id, schema }),

  listTableExtras: (
    id: string,
    schema: string,
    relation: string,
  ): Promise<TableExtrasResult> =>
    call<TableExtrasResult>("mssql_list_table_extras", { id, schema, relation }),

  getRoutineSignature: (
    id: string,
    schema: string,
    name: string,
    kind: string,
  ): Promise<RoutineSignature> =>
    call<RoutineSignature>("mssql_get_routine_signature", { id, schema, name, kind }),

  getObjectDefinition: (id: string, schema: string, name: string): Promise<string | null> =>
    call<string | null>("mssql_get_object_definition", { id, schema, name }),

  // ---------------------------------------------------------------------------
  // Data grid
  // ---------------------------------------------------------------------------

  queryTable: (
    id: string,
    schema: string,
    relation: string,
    options: QueryOptions,
    origin: "auto" | "user" = "auto",
  ): Promise<QueryResult> =>
    call<QueryResult>("mssql_query_table", { id, schema, relation, options, origin }),

  countTable: (
    id: string,
    schema: string,
    relation: string,
    options: Pick<QueryOptions, "filter_tree">,
    origin: "auto" | "user" = "auto",
  ): Promise<CountResult> =>
    call<CountResult>("mssql_count_table", { id, schema, relation, options, origin }),

  // ---------------------------------------------------------------------------
  // Edit
  // ---------------------------------------------------------------------------

  tablePrimaryKey: (
    id: string,
    schema: string,
    relation: string,
    origin: "auto" | "user" = "auto",
  ): Promise<PrimaryKeyResult> =>
    call<PrimaryKeyResult>("mssql_table_primary_key", { id, schema, relation, origin }),

  applyTableEdits: (
    id: string,
    schema: string,
    relation: string,
    edits: EditOp[],
    origin: "auto" | "user" = "user",
  ): Promise<ApplyEditsResult> =>
    call<ApplyEditsResult>("mssql_apply_table_edits", { id, schema, relation, edits, origin }),

  // ---------------------------------------------------------------------------
  // SQL editor
  // ---------------------------------------------------------------------------

  runSql: (id: string, sql: string, origin: "auto" | "user" = "user"): Promise<RunSqlResult> =>
    call<RunSqlResult>("mssql_run_sql", { id, sql, origin }),

  runSqlMany: (
    id: string,
    statements: string[],
    origin: "auto" | "user" = "user",
  ): Promise<MultiSqlResult> =>
    call<MultiSqlResult>("mssql_run_sql_many", { id, statements, origin }),

  // ---------------------------------------------------------------------------
  // Structure
  // ---------------------------------------------------------------------------

  tableStructure: (
    id: string,
    schema: string,
    relation: string,
    origin: "auto" | "user" = "auto",
  ): Promise<TableStructureResult> =>
    call<TableStructureResult>("mssql_table_structure", { id, schema, relation, origin }),

  tableDdl: (
    id: string,
    schema: string,
    relation: string,
    origin: "auto" | "user" = "auto",
  ): Promise<TableDdlResult> =>
    call<TableDdlResult>("mssql_table_ddl", { id, schema, relation, origin }),

  // ---------------------------------------------------------------------------
  // Columns cache
  // ---------------------------------------------------------------------------

  listColumnsBulk: (
    id: string,
    schema: string,
    origin: "auto" | "user" = "auto",
  ): Promise<ColumnsBulkResult> =>
    call<ColumnsBulkResult>("mssql_list_columns_bulk", { id, schema, origin }),
};

export { AppError };
