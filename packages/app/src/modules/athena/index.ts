// Athena frontend module

export { AthenaIcon } from "./icon";
export { athenaApi } from "./api";
export * from "./types";
export { useActiveAthenaConnections } from "./useActiveConnections";
export { AthenaConnectionForm } from "./ConnectionForm";
export { AthenaFormProvider, useAthenaForm } from "./FormController";
export { openAthenaQueryTab } from "./openAthenaQueryTab";
export type { OpenAthenaQueryTabArgs } from "./openAthenaQueryTab";

// Schema browser
export {
  AthenaSchemaTree,
  AthenaSchemaPrimaryActions,
  AthenaSchemaToolbar,
} from "./schema/SchemaTree";
export { athenaSchemaCache } from "./schema/globalSchemaCache";
export { refreshConnection } from "./schema/refresh";

// SQL editor query tab
export { ATHENA_QUERY_KIND } from "./sql/QueryTab";
export { athenaColumnsCache } from "./sql/columnsCache";

// Register the athena-query tab kind (side-effect import).
// This MUST be a bare import so the module body runs and
// TabRegistry.register(ATHENA_QUERY_KIND, ...) is called regardless of
// tree-shaking. See the equivalent pattern in mysql/index.ts (and mssql).
import "./sql/QueryTab";
