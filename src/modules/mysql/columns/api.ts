import { mysqlApi } from "../api";
import type { ColumnsBulkResult } from "../types";

export type Origin = "auto" | "user";

export const columnsApi = {
  listColumnsBulk: (
    id: string,
    schema: string,
    origin: Origin = "auto",
  ): Promise<ColumnsBulkResult> =>
    mysqlApi.listColumnsBulk(id, schema, origin),
};
