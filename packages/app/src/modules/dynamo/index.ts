// Side-effect import: ensures TabRegistry.register(DYNAMO_QUERY_KIND, ...) runs
// at module load. Must be a value import (not `export type`) so the side effect
// is not erased by the bundler.
import "./sql";

export { DYNAMO_KIND } from "./types";
// Re-export as a value (not type) so the constant is available to consumers
// and the side effect import above is not the only reference.
export { DYNAMO_QUERY_KIND } from "./sql";
export type {
  ActiveDynamoConnection,
  AwsCredentials,
  ConnectResult,
  DynamoAuth,
  DynamoParams,
  ProfileInfo,
  TestConnectionResult,
  UpdateCredentialsInput,
} from "./types";
export { dynamoApi } from "./api";
export { classifyDynamoError, extractSsoCommand } from "./errors";
export type { DynamoErrorCategory } from "./errors";
export { DynamoIcon } from "./icon";
export { useActiveDynamoConnections } from "./useActiveConnections";
export { DynamoFormProvider, useDynamoForm } from "./FormController";
export { DynamoConnectionForm } from "./ConnectionForm";
export type { FormMode as DynamoFormMode } from "./ConnectionForm";
export { useDynamoErrorHandler, CredentialsRefreshedListener } from "./ExpirationListener";
export { AWS_REGIONS } from "./regions";
export type { AwsRegion } from "./regions";
export { useDynamoCommands } from "./commands";
export {
  dynamoScan,
  dynamoQuery,
  dynamoCountItems,
  compile as compileDynamoBuilder,
} from "./data-view";
export type {
  AttributeValue,
  AttributeMap,
  SelectMode,
  CountMode,
  ScanRequest,
  ScanResponse,
  QueryRequest,
  QueryResponse,
  CountRequest,
  CountResponse,
  TypedValue,
  FilterRow,
  BuilderState,
  CompileResult,
} from "./data-view";
