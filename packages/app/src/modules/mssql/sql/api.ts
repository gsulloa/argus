import { mssqlApi } from "../api";
import type { MultiSqlResult, RunSqlResult } from "../types";

export type Origin = "auto" | "user";

export const sqlApi = {
  runSql: (id: string, sql: string, origin: Origin = "user"): Promise<RunSqlResult> =>
    mssqlApi.runSql(id, sql, origin),

  runSqlMany: (
    id: string,
    statements: string[],
    origin: Origin = "user",
  ): Promise<MultiSqlResult> =>
    mssqlApi.runSqlMany(id, statements, origin),
};
