/**
 * src/modules/dynamo/data-view — owns the DynamoDB data view:
 *   - IPC wrappers for scan, query, and countItems
 *   - TS mirrors of the backend IPC envelopes and AttributeValue union
 *   - BuilderState → AWS expression compiler
 *
 * Does NOT own: item editing (lands in #12), PartiQL (#13), export/import.
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
export { useDynamoInspectorWidth } from "./useInspectorWidth";
