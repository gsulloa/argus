import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";
import type {
  CountTableResult,
  Filter,
  QueryTableOptions,
  QueryTableResult,
} from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const started = performance.now();
  console.debug("[argus.data] invoke →", cmd, args);
  try {
    const result = await invoke<T>(cmd, args);
    const ms = Math.round(performance.now() - started);
    console.debug("[argus.data] invoke ←", cmd, `(${ms}ms)`);
    return result;
  } catch (e) {
    const ms = Math.round(performance.now() - started);
    console.error("[argus.data] invoke ✕", cmd, `(${ms}ms)`, e);
    throw toAppError(e);
  }
}

export const dataApi = {
  queryTable(
    id: string,
    schema: string,
    relation: string,
    options: QueryTableOptions,
  ): Promise<QueryTableResult> {
    return call<QueryTableResult>("postgres_query_table", {
      id,
      schema,
      relation,
      options,
    });
  },
  countTable(
    id: string,
    schema: string,
    relation: string,
    filters?: Filter[],
  ): Promise<CountTableResult> {
    return call<CountTableResult>("postgres_count_table", {
      id,
      schema,
      relation,
      filters: filters ?? null,
    });
  },
};
