/**
 * Thin invoke() wrappers for dynamo_scan, dynamo_query, dynamo_count_items.
 *
 * Command name convention: the Tauri commands are registered as `dynamo_scan`,
 * `dynamo_query`, `dynamo_count_items` (verified in src-tauri/src/lib.rs).
 * Tauri camelCase ↔ snake_case conversion does NOT apply to the command name
 * string itself — pass the exact registered name.
 *
 * The `connection_id`, `table_name`, and `origin` fields are lifted out as
 * explicit function arguments for ergonomics; the remaining fields come from
 * the request object.
 */

import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";
import type {
  CountRequest,
  CountResponse,
  DeleteItemRequest,
  DeleteItemResponse,
  DynamoModel,
  ModelDraft,
  Origin,
  PutItemRequest,
  PutItemResponse,
  QueryRequest,
  QueryResponse,
  ScanRequest,
  ScanResponse,
  UpdateItemRequest,
  UpdateItemResponse,
} from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

type OmitIpcMeta<T> = Omit<T, "connection_id" | "table_name" | "origin">;

export function dynamoScan(
  connectionId: string,
  tableName: string,
  request: OmitIpcMeta<ScanRequest>,
  origin: Origin = "user",
): Promise<ScanResponse> {
  const req: ScanRequest = {
    ...request,
    connection_id: connectionId,
    table_name: tableName,
    origin,
  };
  return call<ScanResponse>("dynamo_scan", { req });
}

export function dynamoQuery(
  connectionId: string,
  tableName: string,
  request: OmitIpcMeta<QueryRequest>,
  origin: Origin = "user",
): Promise<QueryResponse> {
  const req: QueryRequest = {
    ...request,
    connection_id: connectionId,
    table_name: tableName,
    origin,
  };
  return call<QueryResponse>("dynamo_query", { req });
}

export function dynamoCountItems(
  connectionId: string,
  tableName: string,
  request: OmitIpcMeta<CountRequest>,
  origin: Origin = "user",
): Promise<CountResponse> {
  const req: CountRequest = {
    ...request,
    connection_id: connectionId,
    table_name: tableName,
    origin,
  };
  return call<CountResponse>("dynamo_count_items", { req });
}

export function dynamoPutItem(
  connectionId: string,
  tableName: string,
  request: OmitIpcMeta<PutItemRequest>,
  origin: Origin = "user",
): Promise<PutItemResponse> {
  const req: PutItemRequest = {
    ...request,
    connection_id: connectionId,
    table_name: tableName,
    origin,
  };
  return call<PutItemResponse>("dynamo_put_item", { req });
}

export function dynamoUpdateItem(
  connectionId: string,
  tableName: string,
  request: OmitIpcMeta<UpdateItemRequest>,
  origin: Origin = "user",
): Promise<UpdateItemResponse> {
  const req: UpdateItemRequest = {
    ...request,
    connection_id: connectionId,
    table_name: tableName,
    origin,
  };
  return call<UpdateItemResponse>("dynamo_update_item", { req });
}

/**
 * Fetches all dynamo_model docs whose physical_table matches `tableName`.
 * Returns an empty array when no context folder is linked or when the table
 * has no model docs.
 *
 * Wraps the `context_list_models(connection_id, table)` Tauri command.
 */
export function listModels(
  connectionId: string,
  tableName: string,
): Promise<DynamoModel[]> {
  return call<DynamoModel[]>("context_list_models", {
    connectionId,
    table: tableName,
  });
}

export interface SaveModelResult { path: string; created: boolean; }
export interface DeleteModelResult { deleted: boolean; }

/**
 * Writes (creates or edits) a dynamo_model doc. Wraps `context_save_model`.
 * `physical_table` is derived backend-side from `tableName`, never sent.
 */
export function saveModel(
  connectionId: string,
  tableName: string,
  draft: ModelDraft,
): Promise<SaveModelResult> {
  return call<SaveModelResult>("context_save_model", {
    connectionId,
    table: tableName,
    draft,
  });
}

/** Deletes a dynamo_model doc. Wraps `context_delete_model`. No-op-safe. */
export function deleteModel(
  connectionId: string,
  tableName: string,
  name: string,
): Promise<DeleteModelResult> {
  return call<DeleteModelResult>("context_delete_model", {
    connectionId,
    table: tableName,
    modelName: name,
  });
}

/** Invokes the AI model inspector (fires streaming events on the channel). */
export function inspectModels(
  sessionId: string,
  connectionId: string,
  tableName: string,
): Promise<void> {
  return call<void>("ai_inspect_models", { sessionId, connectionId, table: tableName });
}

/** Returns the project source path linked to this connection (or null). */
export function getProjectSource(connectionId: string): Promise<string | null> {
  return call<string | null>("context_get_project_source", { connectionId });
}

/** Sets the project source path for this connection. */
export function setProjectSource(connectionId: string, path: string): Promise<void> {
  return call<void>("context_set_project_source", { connectionId, path });
}

export function dynamoDeleteItem(
  connectionId: string,
  tableName: string,
  request: OmitIpcMeta<DeleteItemRequest>,
  origin: Origin = "user",
): Promise<DeleteItemResponse> {
  const req: DeleteItemRequest = {
    ...request,
    connection_id: connectionId,
    table_name: tableName,
    origin,
  };
  return call<DeleteItemResponse>("dynamo_delete_item", { req });
}
