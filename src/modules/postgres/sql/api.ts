import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";
import type { CellValue, DataColumn } from "../data/types";

export type Origin = "auto" | "user";

/** Outcome of a single statement run. */
export type RunSqlResult =
  | {
      kind: "rows";
      columns: DataColumn[];
      rows: CellValue[][];
      truncated_columns: string[];
      truncated: boolean;
      query_ms: number;
    }
  | {
      kind: "affected";
      command_tag: string;
      affected_rows: number;
      query_ms: number;
    };

export interface RunSqlErrorEnvelope {
  message: string;
  code: string | null;
  position: number | null;
}

/** Per-statement outcome from `postgres_run_sql_many`. */
export type RunManyOutcome =
  | { status: "ok"; statement_index: number; result: RunSqlResult }
  | { status: "err"; statement_index: number; error: RunSqlErrorEnvelope }
  | { status: "skipped"; statement_index: number };

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const started = performance.now();
  console.debug("[argus.sql] invoke →", cmd, args);
  try {
    const result = await invoke<T>(cmd, args);
    const ms = Math.round(performance.now() - started);
    console.debug("[argus.sql] invoke ←", cmd, `(${ms}ms)`);
    return result;
  } catch (e) {
    const ms = Math.round(performance.now() - started);
    console.error("[argus.sql] invoke ✕", cmd, `(${ms}ms)`, e);
    throw toAppError(e);
  }
}

export const sqlApi = {
  runSql(connectionId: string, sql: string, origin: Origin = "user"): Promise<RunSqlResult> {
    return call<RunSqlResult>("postgres_run_sql", {
      id: connectionId,
      sql,
      origin,
    });
  },
  runSqlMany(
    connectionId: string,
    statements: string[],
    origin: Origin = "user",
  ): Promise<RunManyOutcome[]> {
    return call<RunManyOutcome[]>("postgres_run_sql_many", {
      id: connectionId,
      statements,
      origin,
    });
  },
};
