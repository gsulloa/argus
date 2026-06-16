/**
 * MS SQL Server Tauri command-name constants.
 * Used as a single source of truth to avoid typos when calling `invoke`.
 */
export const MSSQL_COMMANDS = {
  // Connection
  testConnection: "mssql_test_connection",
  connect: "mssql_connect",
  disconnect: "mssql_disconnect",
  disconnectAll: "mssql_disconnect_all",
  listActive: "mssql_list_active",
  parseUrl: "mssql_parse_url",

  // Schema
  listSchemas: "mssql_list_schemas",
  listDatabases: "mssql_list_databases",
  listRelations: "mssql_list_relations",
  listStructure: "mssql_list_structure",
  listTableExtras: "mssql_list_table_extras",
  getRoutineSignature: "mssql_get_routine_signature",
  getObjectDefinition: "mssql_get_object_definition",

  // Data grid
  queryTable: "mssql_query_table",
  countTable: "mssql_count_table",

  // Edit
  applyTableEdits: "mssql_apply_table_edits",
  tablePrimaryKey: "mssql_table_primary_key",

  // SQL editor
  runSql: "mssql_run_sql",
  runSqlMany: "mssql_run_sql_many",
  runSqlBatch: "mssql_run_sql_batch",

  // Structure
  tableStructure: "mssql_table_structure",
  tableDdl: "mssql_table_ddl",

  // Columns cache
  listColumnsBulk: "mssql_list_columns_bulk",
} as const;
