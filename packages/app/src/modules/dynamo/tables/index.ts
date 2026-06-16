// Types
export type {
  BillingMode,
  TableStatus,
  KeyType,
  AttributeType,
  KeySchemaElement,
  AttributeDefinitionInfo,
  ProvisionedThroughputInfo,
  GsiInfo,
  LsiInfo,
  StreamSpecificationInfo,
  TableDescription,
  ListTablesResult,
  Origin,
} from "./types";

// API
export { dynamoTablesApi } from "./api";
export type { ListTablesArgs, DescribeTableArgs } from "./api";

// Cache provider + hooks
export {
  DynamoTablesCacheProvider,
  useDynamoTableCache,
  useDynamoTableCacheRegistry,
} from "./CacheProvider";
export type {
  TablesSlot,
  DescribeSlot,
  DynamoTableCacheHook,
} from "./CacheProvider";

// Sidebar subtree
export { DynamoConnectionSubtree } from "./DynamoConnectionSubtree";

// Tab kind (dynamo-table-placeholder retired; activation now uses dynamo-data-view)
export { openTableTab } from "./openTableTab";
export { migratePlaceholderTabs, DYNAMO_TABLE_PLACEHOLDER_KIND } from "./migrateTabKinds";

// Palette commands
export { useDynamoTablesPaletteCommands } from "./usePaletteCommands";

// Extended registry
export type { ConnectionCacheSnapshot } from "./CacheProvider";
