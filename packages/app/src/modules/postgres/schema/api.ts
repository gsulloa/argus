import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";
import type { BulkColumnInfo } from "./globalSchemaCache";
import type {
  FunctionSignature,
  RelationsResult,
  SchemaSummary,
  StructureResult,
  TableExtrasResult,
  TableStructureResult,
} from "./types";

export interface ColumnsBulkResult {
  schema: string;
  columns_by_relation: Record<string, BulkColumnInfo[]>;
}

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
  listRelations: (id: string, schema: string) =>
    call<RelationsResult>("postgres_list_relations", { id, schemaName: schema }),
  listStructure: (id: string, schema: string) =>
    call<StructureResult>("postgres_list_structure", { id, schemaName: schema }),
  listTableExtras: (id: string, schema: string, relation: string) =>
    call<TableExtrasResult>("postgres_list_table_extras", {
      id,
      schemaName: schema,
      relation,
    }),
  getFunctionSignature: (id: string, schema: string, name: string, oid: number) =>
    call<FunctionSignature>("postgres_get_function_signature", {
      id,
      schemaName: schema,
      name,
      oid,
    }),
  listColumnsBulk: (id: string, schema: string, origin: "auto" | "user" = "auto") =>
    call<ColumnsBulkResult>("postgres_list_columns_bulk", { id, schema, origin }),
  tableStructure: (
    id: string,
    schema: string,
    relation: string,
    origin: "auto" | "user" = "auto",
  ) =>
    call<TableStructureResult>("postgres_table_structure", {
      id,
      schemaName: schema,
      relation,
      origin,
    }),
};
