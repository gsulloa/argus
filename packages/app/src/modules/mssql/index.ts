// MS SQL Server frontend module — Phase F1 (§14–§16) + Phase F2 (§17–§19) + Phase F3 (§20–§22)

export * from "./types";
export { MSSQL_COMMANDS } from "./commandNames";
export { mssqlApi, AppError } from "./api";
export { useActiveMssqlConnections } from "./useActiveConnections";
export { MssqlConnectionForm } from "./ConnectionForm";
export type { ConnectionFormProps as MssqlConnectionFormProps } from "./ConnectionForm";
export { MssqlFormProvider, useMssqlForm } from "./FormController";
export { useMssqlCommands, mssqlQuoteIdent, buildNewQueryHereSql } from "./commands";
export { openMssqlQueryTab, MSSQL_QUERY_KIND } from "./openMssqlQueryTab";
export type { OpenMssqlQueryTabArgs } from "./openMssqlQueryTab";
export { default as MssqlIcon } from "./icon";

// Phase F2 — schema browser
export { MssqlSchemaTree, MssqlSchemaPrimaryActions, MssqlSchemaToolbar } from "./schema/SchemaTree";
export { MssqlObjectPlaceholderTabRoot as MssqlObjectPlaceholderTab } from "./MssqlObjectPlaceholderTab";

// Phase F2 — data grid
export { MssqlTableViewerTab, MSSQL_TABLE_DATA_KIND } from "./data/TableViewerTab";
export type { MssqlTableDataPayload } from "./data/TableViewerTab";

// Phase F3 — SQL editor (§20)
export type { MssqlQueryPayload } from "./sql/QueryTab";
// Register the mssql-query tab kind (side-effect import). The type-only re-export
// above is erased at compile time and never evaluates the module, so without this
// the TabRegistry.register call in QueryTab.tsx never runs.
import "./sql/QueryTab";

// Phase F3 — table structure (§21)
export { StructureSubtab as MssqlStructureSubtab } from "./structure/StructureSubtab";
export { RawSubtab as MssqlRawSubtab } from "./structure/RawSubtab";
export { useTableStructureCache as useMssqlTableStructureCache } from "./structure/useTableStructureCache";
export type { TableStructureCache as MssqlTableStructureCache } from "./structure/useTableStructureCache";

// Phase F3 — columns cache (§22)
export { mssqlBulkColumnsCache } from "./columns/columnsCache";
