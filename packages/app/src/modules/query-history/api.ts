import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";

export type HistoryStatus = "ok" | "err";
export type HistoryOrigin = "user" | "auto";

export interface HistoryEntry {
  id: string;
  connection_id: string;
  connection_name: string;
  sql: string;
  origin: HistoryOrigin;
  status: HistoryStatus;
  started_at: number;
  duration_ms: number;
  row_count?: number | null;
  command_tag?: string | null;
  error_code?: string | null;
  error_message?: string | null;
}

export interface HistoryFilters {
  connection_ids?: string[];
  since?: number;
  until?: number;
  search?: string;
  status?: HistoryStatus;
}

export interface HistoryListRequest extends HistoryFilters {
  limit?: number;
  offset?: number;
}

export interface HistoryListResponse {
  entries: HistoryEntry[];
  total: number;
}

export interface HistoryClearResponse {
  deleted: number;
}

export interface DistinctConnection {
  id: string;
  name: string;
}

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const historyApi = {
  list(request: HistoryListRequest = {}): Promise<HistoryListResponse> {
    return call<HistoryListResponse>("query_history_list", { request });
  },
  delete(id: string): Promise<void> {
    return call<void>("query_history_delete", { id });
  },
  clear(filters: HistoryFilters = {}): Promise<HistoryClearResponse> {
    return call<HistoryClearResponse>("query_history_clear", { filters });
  },
  distinctConnections(): Promise<DistinctConnection[]> {
    return call<DistinctConnection[]>("query_history_distinct_connections", {});
  },
};
