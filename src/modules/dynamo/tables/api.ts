/**
 * Typed invoke() wrappers for the dynamo_list_tables and dynamo_describe_table
 * Tauri commands.
 *
 * Pattern mirrors src/modules/dynamo/api.ts exactly:
 *   - a private `call<T>()` helper that wraps invoke() + toAppError()
 *   - exported methods on a named API object
 *
 * Argument objects use camelCase keys (Tauri converts to snake_case for Rust).
 */

import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";
import type { ListTablesResult, TableDescription, Origin } from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export interface ListTablesArgs {
  connectionId: string;
  paginationToken?: string;
  cap?: number;
  origin: Origin;
}

export interface DescribeTableArgs {
  connectionId: string;
  tableName: string;
  origin: Origin;
}

export const dynamoTablesApi = {
  /**
   * List DynamoDB table names for the given connection.
   *
   * - `paginationToken`: resume token from a previous truncated response.
   * - `cap`: maximum number of names to return. Omit to let the backend
   *   resolve the per-connection setting (or default 1000).
   * - `origin`: "auto" for mount/background fetches; "user" for explicit
   *   user-triggered refreshes.
   */
  listTables: ({
    connectionId,
    paginationToken,
    cap,
    origin,
  }: ListTablesArgs): Promise<ListTablesResult> =>
    call<ListTablesResult>("dynamo_list_tables", {
      connectionId,
      paginationToken: paginationToken ?? null,
      cap: cap ?? null,
      origin,
    }),

  /**
   * Describe a single DynamoDB table.
   *
   * - `origin`: "auto" for viewport-driven background describes; "user" for
   *   explicit retries.
   */
  describeTable: ({
    connectionId,
    tableName,
    origin,
  }: DescribeTableArgs): Promise<TableDescription> =>
    call<TableDescription>("dynamo_describe_table", {
      connectionId,
      tableName,
      origin,
    }),
};
