import { useCallback, useState } from "react";
import { AppError } from "@/platform/errors/AppError";
import { sqlApi, type RunManyOutcome, type RunSqlResult } from "./api";
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

export type RunState =
  | { status: "idle" }
  | { status: "running" }
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

  const reset = useCallback(() => {
    setState({ status: "idle" });
    setRunStartedAt(null);
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

      setState({ status: "running" });
      setRunStartedAt(Date.now());

      if (mode === "single") {
        try {
          const result = await sqlApi.runSql(connectionId, sqlToRun, "user");
          setState({
            status: "done",
            mode: "single",
            sql: sqlToRun,
            startOffset,
            result,
            error: null,
          });
        } catch (e) {
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
        }
        setRunStartedAt(null);
        return;
      }

      // Multi.
      try {
        const outcomes = await sqlApi.runSqlMany(
          connectionId,
          multiStatements.map((s) => s.sql),
          "user",
        );
        setState({
          status: "done",
          mode: "multi",
          statements: multiStatements,
          outcomes,
        });
      } catch (e) {
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
      setRunStartedAt(null);
    },
    [],
  );

  const summary = summarize(state);

  return { state, summary, runStartedAt, run, reset };
}

function summarize(state: RunState): string | null {
  if (state.status === "running") return "Running…";
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
