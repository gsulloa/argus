import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";
import type { SchemaObjects, SchemaSummary } from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const started = performance.now();
  console.debug("[argus.schema] invoke →", cmd, args);
  try {
    const result = await invoke<T>(cmd, args);
    const ms = Math.round(performance.now() - started);
    console.debug("[argus.schema] invoke ←", cmd, `(${ms}ms)`);
    return result;
  } catch (e) {
    const ms = Math.round(performance.now() - started);
    console.error("[argus.schema] invoke ✕", cmd, `(${ms}ms)`, e);
    throw toAppError(e);
  }
}

export const schemaApi = {
  listSchemas: (id: string) => call<SchemaSummary[]>("postgres_list_schemas", { id }),
  listObjects: (id: string, schema: string) =>
    call<SchemaObjects>("postgres_list_objects", { id, schemaName: schema }),
};
