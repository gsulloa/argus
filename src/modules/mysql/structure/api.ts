import { mysqlApi } from "../api";
import type { TableDdlResult, TableStructureResult } from "../types";

export type Origin = "auto" | "user";

export const structureApi = {
  tableStructure: (
    id: string,
    schema: string,
    relation: string,
    origin: Origin = "auto",
  ): Promise<TableStructureResult> =>
    mysqlApi.tableStructure(id, schema, relation, origin),

  tableDdl: (
    id: string,
    schema: string,
    relation: string,
    origin: Origin = "auto",
  ): Promise<TableDdlResult> =>
    mysqlApi.tableDdl(id, schema, relation, origin),
};
