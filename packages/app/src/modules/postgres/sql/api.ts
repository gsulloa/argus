import { invoke, Channel } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";
import type { RowCapSource } from "@/platform/sql/TruncationBanner";
import type { CellValue, DataColumn, ResultEditability } from "../data/types";

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
      row_cap: number;
      row_cap_source: RowCapSource;
      /**
       * Whether these rows can be written back. Rows-shaped results only —
       * `kind: "affected"` carries no such notion, so switch on `kind` first.
       */
      editability: ResultEditability;
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

/** Discriminated event emitted by the `postgres_run_sql_stream` channel. */
export type StreamEvent =
  | { event: "columns"; columns: DataColumn[]; editability: ResultEditability }
  | { event: "batch"; rows: CellValue[][] }
  | {
      event: "done";
      row_count: number;
      truncated: boolean;
      query_ms: number;
      truncated_columns: string[];
      row_cap: number;
      row_cap_source: RowCapSource;
    }
  | { event: "affected"; command_tag: string; affected_rows: number; query_ms: number }
  | { event: "error"; message: string; code: string | null; position: number | null };

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
  runSql(
    connectionId: string,
    sql: string,
    origin: Origin = "user",
    runToken?: string,
  ): Promise<RunSqlResult> {
    return call<RunSqlResult>("postgres_run_sql", {
      id: connectionId,
      sql,
      origin,
      runToken,
    });
  },
  runSqlMany(
    connectionId: string,
    statements: string[],
    origin: Origin = "user",
    runToken?: string,
  ): Promise<RunManyOutcome[]> {
    return call<RunManyOutcome[]>("postgres_run_sql_many", {
      id: connectionId,
      statements,
      origin,
      runToken,
    });
  },
  runSqlStream(
    connectionId: string,
    sql: string,
    origin: Origin = "user",
    runToken: string,
    onEvent: (ev: StreamEvent) => void,
  ): Promise<void> {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    return call<void>("postgres_run_sql_stream", { id: connectionId, sql, origin, runToken, onEvent: channel });
  },
  cancelQuery(runToken: string): Promise<void> {
    return invoke<void>("cancel_running_query", { runToken }).catch((e) => {
      console.warn("[argus.sql] cancel_running_query failed:", e);
    });
  },
};
