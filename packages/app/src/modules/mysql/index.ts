// MySQL frontend module — Phase F1 (§14–§16) + Phase F2 (§17–§19) + Phase F3 (§20–§22)

export { MysqlIcon } from "./icon";
export { mysqlApi } from "./api";
export * from "./types";
export { useActiveMysqlConnections } from "./useActiveConnections";
export { MysqlConnectionForm } from "./ConnectionForm";
export { MysqlFormProvider, useMysqlForm } from "./FormController";
export { useMysqlCommands } from "./commands";
export { openMysqlQueryTab } from "./openMysqlQueryTab";
export type { OpenMysqlQueryTabArgs } from "./openMysqlQueryTab";

// §17 — Schema browser
export {
  MysqlSchemaTree,
  MysqlSchemaPrimaryActions,
  MysqlSchemaToolbar,
} from "./schema/SchemaTree";
export { useSchemaTree } from "./schema/useSchemaTree";
export { useVisibleSchemas } from "./schema/useVisibleSchemas";
export { VisibleSchemasPicker } from "./schema/VisibleSchemasPicker";
export { mysqlSchemaCache } from "./schema/globalSchemaCache";
export {
  emitMysqlSchemaEvent,
  subscribeMysqlSchemaEvent,
  refreshConnection,
} from "./schema/events";
export type { MysqlSchemaEvent } from "./schema/events";
export {
  openMysqlObjectTab,
  MYSQL_TABLE_DATA_KIND,
  MYSQL_OBJECT_PLACEHOLDER_KIND,
} from "./schema/openObjectTab";

// §18–§19 — Data grid & edit buffer
export { MysqlTableViewerTab, MYSQL_TABLE_DATA_KIND as MYSQL_TABLE_DATA_TAB_KIND } from "./data/TableViewerTab";
export { useTableData } from "./data/useTableData";
export { useEditBuffer } from "./data/useEditBuffer";

// §20 — SQL editor query tab
export { MYSQL_QUERY_KIND } from "./sql/QueryTab";
export { mysqlBulkColumnsCache } from "./sql/columnsCache";

// §23.7 — Register mysql-object-placeholder tab kind (side-effect import).
import "./MysqlObjectPlaceholderTab";
