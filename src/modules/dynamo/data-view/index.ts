/**
 * src/modules/dynamo/data-view — Scan / Query browsing of DynamoDB items.
 * Owns: DataViewTab (Toolbar, QueryBuilder, Tabla grid, JSON view, Inspector,
 *   BottomBar), IPC wrappers (dynamoScan/Query/Count), AttributeValue types,
 *   BuilderState → AWS expression compiler, useDynamoItems / useCount hooks.
 * Does NOT own: item editing (#12), PartiQL (#13), export (#13 family).
 */

export { dynamoScan, dynamoQuery, dynamoCountItems } from "./api";
export { compile } from "./builderCompiler";
export type { CompileResult } from "./builderCompiler";
export { useDynamoItems } from "./useDynamoItems";
export type {
  DynamoItemsStatus,
  UseDynamoItemsParams,
  UseDynamoItemsResult,
} from "./useDynamoItems";
export type {
  AttributeValue,
  AttributeMap,
  SelectMode,
  CountMode,
  Origin,
  ScanRequest,
  ScanResponse,
  QueryRequest,
  QueryResponse,
  CountRequest,
  CountResponse,
  TypedValue,
  FilterRow,
  BuilderState,
} from "./types";

// Tab kind
export {
  DYNAMO_DATA_VIEW_KIND,
  openDataViewTab,
  type DynamoDataViewPayload,
} from "./DataViewTab";
export { BottomBar } from "./BottomBar";
export type { BottomBarProps, CountResult } from "./BottomBar";
export { MetadataView } from "./MetadataView";
export type { MetadataViewProps } from "./MetadataView";
export { Toolbar } from "./Toolbar";
export type { ToolbarProps, ViewMode } from "./Toolbar";
export { QueryBuilder } from "./QueryBuilder";
export type { QueryBuilderProps } from "./QueryBuilder";
export { useDynamoInspectorWidth } from "./useInspectorWidth";
