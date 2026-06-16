import { mssqlApi } from "../api";
import type { TableDdlResult, TableStructureResult } from "../types";

export type Origin = "auto" | "user";

export const structureApi = {
  tableStructure: (
    id: string,
    schema: string,
    relation: string,
    origin: Origin = "auto",
  ): Promise<TableStructureResult> =>
    mssqlApi.tableStructure(id, schema, relation, origin),

  tableDdl: (
    id: string,
    schema: string,
    relation: string,
    origin: Origin = "auto",
  ): Promise<TableDdlResult> =>
    mssqlApi.tableDdl(id, schema, relation, origin),
};
