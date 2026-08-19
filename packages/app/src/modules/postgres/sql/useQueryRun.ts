import { useCallback, useRef, useState } from "react";
import { AppError } from "@/platform/errors/AppError";
import { DEFAULT_ROW_CAP } from "@/platform/sql/useRowCap";
import { sqlApi, type RunManyOutcome, type RunSqlResult, type StreamEvent } from "./api";
import type { CellValue, DataColumn } from "../data/types";
import {
  splitStatements,
  getStatementUnderCursor,
  type Statement,
} from "./splitStatements";

export interface SingleRunState {
  mode: "single";
  /** The actual SQL that was sent. */
  sql: string;
  /** Offset of the executed statement inside the editor's full document. */
  startOffset: number;
  result: RunSqlResult | null;
  error: { message: string; code: string | null; position: number | null } | null;
}

export interface MultiRunState {
  mode: "multi";
  statements: Statement[];
  outcomes: RunManyOutcome[];
}

/** Intermediate state while streaming rows are arriving. */
export interface StreamingRunState {
  mode: "single";
  sql: string;
  startOffset: number;
  columns: DataColumn[];
  rows: CellValue[][];      // accumulated so far
  loadedCount: number;
}

export type RunState =
  | { status: "idle" }
  | { status: "running" }                                   // dispatched, before columns
  | ({ status: "streaming" } & StreamingRunState)           // columns known, rows arriving
  | { status: "cancelled" }
  | ({ status: "done" } & (SingleRunState | MultiRunState));

export interface UseQueryRunResult {
  state: RunState;
  /** Last-completed run summary text (e.g. `5 rows · 12 ms`), or null. */
  summary: string | null;
  /** `Date.now()` at which the latest run transitioned to `running`, or null otherwise. */
  runStartedAt: number | null;
  /**
   * Run whatever applies based on the editor state.
   *
   * 5.6: `connectionId` is now a required argument passed at call time rather
   * than captured as a stable closure value. The caller (QueryTab) is
   * responsible for validating that `connectionId` is non-null before calling
   * `run()` and for surfacing the "Select a connection first." toast when it is.
   */
  run(args: {
    connectionId: string;
    fullSql: string;
    selectionFrom: number;
    selectionTo: number;
    cursor: number;
    forceAll?: boolean;
  }): Promise<void>;
  /** Cancel the in-flight query (best-effort; no-op when idle). */
  cancel(): void;
  /** Reset runner state back to idle (used when switching connections). */
  reset(): void;
}

/**
 * Hook that manages a single query-run lifecycle.
 *
 * 5.6 change: no longer receives `connectionId` as a hook argument.
 * The connection is passed per-invocation to `run()`, making it safe
 * to change the connection in the same tab without recreating the runner.
 */
export function useQueryRun(): UseQueryRunResult {
  const [state, setState] = useState<RunState>({ status: "idle" });
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const runTokenRef = useRef<string | null>(null);

  // Streaming accumulation refs (reset per run).
  const columnsRef = useRef<DataColumn[] | null>(null);
  const rowsRef = useRef<CellValue[][]>([]);
  const loadedRef = useRef<number>(0);
  const terminalRef = useRef<boolean>(false);
  const cancelRequestedRef = useRef<boolean>(false);
  const commitTimerRef = useRef<number | null>(null);

  // Captured per-run values for the commit closure.
  const streamingSqlRef = useRef<string>("");
  const streamingStartOffsetRef = useRef<number>(0);
  const streamingRunTokenRef = useRef<string>("");

  const reset = useCallback(() => {
    setState({ status: "idle" });
    setRunStartedAt(null);
  }, []);

  const cancel = useCallback(() => {
    const token = runTokenRef.current;
    if (!token) return;
    // Set cancel flag BEFORE calling cancelQuery so the post-await block knows
    // it was a user cancel when the promise resolves.
    cancelRequestedRef.current = true;
    sqlApi.cancelQuery(token).catch((e) => {
      console.warn("[argus.sql] cancel failed:", e);
    });
  }, []);

  const run = useCallback(
    async (args: {
      connectionId: string;
      fullSql: string;
      selectionFrom: number;
      selectionTo: number;
      cursor: number;
      forceAll?: boolean;
    }) => {
      const { connectionId, fullSql, selectionFrom, selectionTo, cursor, forceAll = false } = args;

      // Decide what to run. Selection wins, then run-all, then statement
      // under cursor. Resolve into either a single SQL string or a
      // multi-statement plan in one pass.
      type Plan =
        | { mode: "single"; sql: string; startOffset: number }
        | { mode: "multi"; statements: Statement[] };

      const plan: Plan | null = (() => {
        if (forceAll) {
          const stmts = splitStatements(fullSql);
          if (stmts.length === 0) return null;
          if (stmts.length === 1) {
            return {
              mode: "single",
              sql: stmts[0]!.sql,
              startOffset: stmts[0]!.startOffset,
            };
          }
          return { mode: "multi", statements: stmts };
        }
        if (selectionFrom !== selectionTo) {
          const sel = fullSql.slice(selectionFrom, selectionTo);
          const stmts = splitStatements(sel);
          if (stmts.length === 0) return null;
          if (stmts.length === 1) {
            return {
              mode: "single",
              sql: stmts[0]!.sql,
              startOffset: selectionFrom + stmts[0]!.startOffset,
            };
          }
          return {
            mode: "multi",
            statements: stmts.map((s) => ({
              sql: s.sql,
              startOffset: selectionFrom + s.startOffset,
              endOffset: selectionFrom + s.endOffset,
            })),
          };
        }
        const stmt = getStatementUnderCursor(fullSql, cursor);
        if (!stmt) return null;
        return { mode: "single", sql: stmt.sql, startOffset: stmt.startOffset };
      })();

      if (!plan) return;

      const mode = plan.mode;
      const sqlToRun = plan.mode === "single" ? plan.sql : "";
      const startOffset = plan.mode === "single" ? plan.startOffset : 0;
      const multiStatements: Statement[] =
        plan.mode === "multi" ? plan.statements : [];

      const runToken = crypto.randomUUID();
      runTokenRef.current = runToken;

      if (mode === "single") {
        // Reset streaming refs for this run.
        columnsRef.current = null;
        rowsRef.current = [];
        loadedRef.current = 0;
        terminalRef.current = false;
        cancelRequestedRef.current = false;
        if (commitTimerRef.current !== null) {
          window.clearTimeout(commitTimerRef.current);
          commitTimerRef.current = null;
        }
        streamingSqlRef.current = sqlToRun;
        streamingStartOffsetRef.current = startOffset;
        streamingRunTokenRef.current = runToken;

        setState({ status: "running" });
        setRunStartedAt(Date.now());
        const dispatchedAt = Date.now();

        // Coalesced commit: write streaming state to React at most every ~60ms.
        const commit = () => {
          commitTimerRef.current = null;
          // Guard: only commit if still streaming for THIS run token.
          if (runTokenRef.current !== streamingRunTokenRef.current) return;
          const cols = columnsRef.current;
          if (!cols) return;
          setState({
            status: "streaming",
            mode: "single",
            sql: streamingSqlRef.current,
            startOffset: streamingStartOffsetRef.current,
            columns: cols,
            rows: rowsRef.current.slice(),
            loadedCount: loadedRef.current,
          });
        };

        const scheduleCommit = () => {
          if (commitTimerRef.current !== null) return;
          commitTimerRef.current = window.setTimeout(commit, 60);
        };

        const flushCommit = () => {
          if (commitTimerRef.current !== null) {
            window.clearTimeout(commitTimerRef.current);
            commitTimerRef.current = null;
          }
          commit();
        };

        const onEvent = (ev: StreamEvent) => {
          // Stale-guard: ignore events from a previous run's channel.
          if (runTokenRef.current !== runToken) return;

          if (ev.event === "columns") {
            columnsRef.current = ev.columns;
            rowsRef.current = [];
            loadedRef.current = 0;
            // Immediately switch to streaming so the grid appears at once.
            setState({
              status: "streaming",
              mode: "single",
              sql: sqlToRun,
              startOffset,
              columns: ev.columns,
              rows: [],
              loadedCount: 0,
            });
          } else if (ev.event === "batch") {
            for (const row of ev.rows) {
              rowsRef.current.push(row);
            }
            loadedRef.current += ev.rows.length;
            scheduleCommit();
          } else if (ev.event === "done") {
            terminalRef.current = true;
            flushCommit();
            setState({
              status: "done",
              mode: "single",
              sql: sqlToRun,
              startOffset,
              result: {
                kind: "rows",
                columns: columnsRef.current ?? [],
                rows: rowsRef.current,
                truncated_columns: ev.truncated_columns,
                truncated: ev.truncated,
                query_ms: ev.query_ms,
                row_cap: ev.row_cap,
                row_cap_source: ev.row_cap_source,
              },
              error: null,
            });
            runTokenRef.current = null;
            setRunStartedAt(null);
          } else if (ev.event === "affected") {
            terminalRef.current = true;
            setState({
              status: "done",
              mode: "single",
              sql: sqlToRun,
              startOffset,
              result: {
                kind: "affected",
                command_tag: ev.command_tag,
                affected_rows: ev.affected_rows,
                query_ms: ev.query_ms,
              },
              error: null,
            });
            runTokenRef.current = null;
            setRunStartedAt(null);
          } else if (ev.event === "error") {
            terminalRef.current = true;
            setState({
              status: "done",
              mode: "single",
              sql: sqlToRun,
              startOffset,
              result: null,
              error: {
                message: ev.message,
                code: ev.code,
                position: ev.position,
              },
            });
            runTokenRef.current = null;
            setRunStartedAt(null);
          }
        };

        try {
          await sqlApi.runSqlStream(connectionId, sqlToRun, "user", runToken, onEvent);

          // The command promise resolved. Check if a terminal event handled finalization.
          if (terminalRef.current) {
            // Terminal event already set final state; nothing to do.
            return;
          }

          // No terminal event arrived — this means either:
          //   a) The run was cancelled (backend stopped, no terminal event on cancel), OR
          //   b) A terminal event is still racing in flight.
          if (!cancelRequestedRef.current) {
            // Not a user cancel — wait a short grace period for a racing terminal event.
            await new Promise<void>((r) => setTimeout(r, 120));
            if (terminalRef.current) {
              // Terminal arrived during grace period; state already set.
              return;
            }
          }

          // Finalize: cancel-with-partial-rows scenario.
          flushCommit();
          if (columnsRef.current !== null) {
            // We have column metadata — keep partial rows visible as a completed result.
            // No `done` event arrived (cancelled mid-stream), so there is no real cap
            // info to report — `truncated: false` means the banner never reads these.
            setState({
              status: "done",
              mode: "single",
              sql: sqlToRun,
              startOffset,
              result: {
                kind: "rows",
                columns: columnsRef.current,
                rows: rowsRef.current,
                truncated_columns: [],
                truncated: false,
                query_ms: Date.now() - dispatchedAt,
                row_cap: DEFAULT_ROW_CAP,
                row_cap_source: "setting",
              },
              error: null,
            });
          } else {
            // Cancelled before any columns arrived.
            setState({ status: "cancelled" });
          }
          runTokenRef.current = null;
          setRunStartedAt(null);
        } catch (e) {
          // Pre-flight reject (empty SQL, bad uuid, no active pool, sslmode/acquire errors).
          if (e instanceof AppError && e.kind === "Cancelled") {
            // Cancelled pre-flight.
            if (columnsRef.current !== null) {
              // Had partial rows — keep them. No `done` event arrived, so there is no
              // real cap info to report — `truncated: false` means the banner never
              // reads these.
              flushCommit();
              setState({
                status: "done",
                mode: "single",
                sql: sqlToRun,
                startOffset,
                result: {
                  kind: "rows",
                  columns: columnsRef.current,
                  rows: rowsRef.current,
                  truncated_columns: [],
                  truncated: false,
                  query_ms: Date.now() - dispatchedAt,
                  row_cap: DEFAULT_ROW_CAP,
                  row_cap_source: "setting",
                },
                error: null,
              });
            } else {
              setState({ status: "cancelled" });
            }
            runTokenRef.current = null;
            setRunStartedAt(null);
            return;
          }
          const err = e instanceof AppError ? e : new AppError("Internal", String(e));
          setState({
            status: "done",
            mode: "single",
            sql: sqlToRun,
            startOffset,
            result: null,
            error: {
              message: err.postgres?.message ?? err.message,
              code: err.postgres?.code ?? null,
              position: err.postgres?.position ?? null,
            },
          });
          runTokenRef.current = null;
          setRunStartedAt(null);
        }
        return;
      }

      // Multi-statement path — unchanged, non-streaming.
      setState({ status: "running" });
      setRunStartedAt(Date.now());

      try {
        const outcomes = await sqlApi.runSqlMany(
          connectionId,
          multiStatements.map((s) => s.sql),
          "user",
          runToken,
        );
        setState({
          status: "done",
          mode: "multi",
          statements: multiStatements,
          outcomes,
        });
      } catch (e) {
        if (e instanceof AppError && e.kind === "Cancelled") {
          setState({ status: "cancelled" });
          setRunStartedAt(null);
          runTokenRef.current = null;
          return;
        }
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        const synthetic: RunManyOutcome[] = multiStatements.map((_, idx) => {
          if (idx === 0) {
            return {
              status: "err",
              statement_index: idx,
              error: {
                message: err.postgres?.message ?? err.message,
                code: err.postgres?.code ?? null,
                position: err.postgres?.position ?? null,
              },
            };
          }
          return { status: "skipped", statement_index: idx };
        });
        setState({
          status: "done",
          mode: "multi",
          statements: multiStatements,
          outcomes: synthetic,
        });
      }
      runTokenRef.current = null;
      setRunStartedAt(null);
    },
    [],
  );

  const summary = summarize(state);

  return { state, summary, runStartedAt, run, cancel, reset };
}

function summarize(state: RunState): string | null {
  if (state.status === "running") return "Running…";
  if (state.status === "streaming") return `Loading… ${state.loadedCount.toLocaleString()} rows`;
  if (state.status === "cancelled") return "Query cancelled";
  if (state.status !== "done") return null;
  if (state.mode === "single") {
    if (state.error) return `error · ${state.error.code ?? "—"}`;
    if (!state.result) return null;
    if (state.result.kind === "rows") {
      const trunc = state.result.truncated ? " (truncated)" : "";
      return `${state.result.rows.length} rows · ${state.result.query_ms} ms${trunc}`;
    }
    return `${state.result.affected_rows} rows affected · ${state.result.query_ms} ms`;
  }
  // multi
  const ok = state.outcomes.filter((o) => o.status === "ok").length;
  const err = state.outcomes.filter((o) => o.status === "err").length;
  return `${ok} ok · ${err} err · ${state.outcomes.length} statements`;
}
