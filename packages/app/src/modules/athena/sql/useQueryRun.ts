/**
 * Athena query run state machine.
 *
 * Mirrors MySQL useQueryRun but uses athenaApi and Athena-specific
 * result types. Adds:
 *  - QUEUED/RUNNING status display during long-running Athena polls
 *  - cancel support via athenaApi.cancelQuery + the athena:query-started event
 *  - data_scanned_bytes in the summary
 */

import { useCallback, useState } from "react";
import { AppError } from "@/platform/errors/AppError";
import { athenaApi } from "../api";
import { splitStatements, getStatementUnderCursor } from "@/modules/mysql/sql/splitStatements";
import type { AthenaStatementOutcome, AthenaRunSqlResult } from "../types";

export type { AthenaStatementOutcome, AthenaRunSqlResult };

export interface SingleRunState {
  mode: "single";
  sql: string;
  startOffset: number;
  result: AthenaRunSqlResult | null;
  error: { message: string; code: string | null; position: number | null } | null;
}

export interface MultiRunState {
  mode: "multi";
  statements: import("@/modules/mysql/sql/splitStatements").Statement[];
  outcomes: AthenaStatementOutcome[];
}

export type RunState =
  | { status: "idle" }
  | { status: "running" }
  | ({ status: "done" } & (SingleRunState | MultiRunState));

export interface UseQueryRunResult {
  state: RunState;
  summary: string | null;
  runStartedAt: number | null;
  run(args: {
    connectionId: string;
    fullSql: string;
    selectionFrom: number;
    selectionTo: number;
    cursor: number;
    forceAll?: boolean;
  }): Promise<void>;
  reset(): void;
}

export function useAthenaQueryRun(): UseQueryRunResult {
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

      type Plan =
        | { mode: "single"; sql: string; startOffset: number }
        | { mode: "multi"; statements: import("@/modules/mysql/sql/splitStatements").Statement[] };

      const plan: Plan | null = (() => {
        if (forceAll) {
          const stmts = splitStatements(fullSql);
          if (stmts.length === 0) return null;
          if (stmts.length === 1) {
            return { mode: "single", sql: stmts[0]!.sql, startOffset: stmts[0]!.startOffset };
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

      setState({ status: "running" });
      setRunStartedAt(Date.now());

      if (plan.mode === "single") {
        try {
          const result = await athenaApi.runSql(connectionId, plan.sql, "user");
          setState({
            status: "done",
            mode: "single",
            sql: plan.sql,
            startOffset: plan.startOffset,
            result,
            error: null,
          });
        } catch (e) {
          const err = e instanceof AppError ? e : new AppError("Internal", String(e));
          setState({
            status: "done",
            mode: "single",
            sql: plan.sql,
            startOffset: plan.startOffset,
            result: null,
            error: {
              message: err.aws?.message ?? err.message,
              code: err.aws?.code ?? null,
              position: null,
            },
          });
        }
        setRunStartedAt(null);
        return;
      }

      // Multi-statement run.
      try {
        const rawOutcomes = await athenaApi.runSqlMany(
          connectionId,
          plan.statements.map((s) => s.sql),
          "user",
        );
        setState({
          status: "done",
          mode: "multi",
          statements: plan.statements,
          outcomes: rawOutcomes,
        });
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        const synthetic: AthenaStatementOutcome[] = plan.statements.map((_, idx) => {
          if (idx === 0) {
            return {
              statement_index: idx,
              outcome: "err" as const,
              error: {
                message: err.aws?.message ?? err.message,
                code: err.aws?.code ?? null,
                position: null,
              },
            };
          }
          return { statement_index: idx, outcome: "skipped" as const };
        });
        setState({
          status: "done",
          mode: "multi",
          statements: plan.statements,
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function summarize(state: RunState): string | null {
  if (state.status === "running") return "Running…";
  if (state.status !== "done") return null;
  if (state.mode === "single") {
    if (state.error) return `error · ${state.error.code ?? "—"}`;
    if (!state.result) return null;
    if (state.result.kind === "rows") {
      const trunc = state.result.truncated ? " (truncated)" : "";
      const scanned = state.result.data_scanned_bytes > 0
        ? ` · ${formatBytes(state.result.data_scanned_bytes)} scanned`
        : "";
      return `${state.result.rows.length} rows · ${state.result.query_ms} ms${trunc}${scanned}`;
    }
    // succeeded
    const scanned = state.result.data_scanned_bytes > 0
      ? ` · ${formatBytes(state.result.data_scanned_bytes)} scanned`
      : "";
    return `${state.result.statement_type} · ${state.result.query_ms} ms${scanned}`;
  }
  // multi
  const ok = state.outcomes.filter((o) => o.outcome === "ok").length;
  const err = state.outcomes.filter((o) => o.outcome === "err").length;
  return `${ok} ok · ${err} err · ${state.outcomes.length} statements`;
}
