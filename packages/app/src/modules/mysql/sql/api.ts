import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";
import type { MultiSqlResult, RunSqlResult } from "../types";

export type Origin = "auto" | "user";

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const sqlApi = {
  runSql: (id: string, sql: string, origin: Origin = "user", runToken?: string): Promise<RunSqlResult> =>
    call<RunSqlResult>("mysql_run_sql", { id, sql, origin, runToken }),

  runSqlMany: (
    id: string,
    statements: string[],
    origin: Origin = "user",
    runToken?: string,
  ): Promise<MultiSqlResult> =>
    call<MultiSqlResult>("mysql_run_sql_many", { id, statements, origin, runToken }),

  cancelQuery(runToken: string): Promise<void> {
    return invoke<void>("cancel_running_query", { runToken }).catch((e) => {
      console.warn("[argus.mysql.sql] cancel_running_query failed:", e);
    });
  },
};
