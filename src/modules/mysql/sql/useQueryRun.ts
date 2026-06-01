/**
 * §20.3 — MySQL query run state machine.
 *
 * Mirrors the Postgres useQueryRun but uses `sqlApi` (MySQL backend commands)
 * and MySQL-aware `splitStatements` / `getStatementUnderCursor`.
 *
 * Shortcuts:
 *   Mod-Enter      → run current statement (selection or statement under cursor)
 *   Mod-Shift-Enter → run all statements in the buffer
 */

import { useCallback, useState } from "react";
import { AppError } from "@/platform/errors/AppError";
import { sqlApi } from "./api";
import { splitStatements, getStatementUnderCursor, validateBatch } from "./splitStatements";
import type { StatementOutcome, RunSqlResult } from "../types";

export type { StatementOutcome, RunSqlResult };

export interface SingleRunState {
  mode: "single";
  sql: string;
  startOffset: number;
  result: RunSqlResult | null;
  error: { message: string; code: string | null; position: number | null } | null;
}

export interface MultiRunState {
  mode: "multi";
  statements: import("./splitStatements").Statement[];
  outcomes: StatementOutcome[];
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

      import("./splitStatements").then(() => {}).catch(() => {});

      type Plan =
        | { mode: "single"; sql: string; startOffset: number }
        | { mode: "multi"; statements: import("./splitStatements").Statement[] };

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

      // Validate multi-statement batch for DELIMITER rejections.
      if (plan.mode === "multi") {
        const validationErr = validateBatch(plan.statements);
        if (validationErr) {
          setState({
            status: "done",
            mode: "single",
            sql: "",
            startOffset: 0,
            result: null,
            error: { message: validationErr, code: null, position: null },
          });
          return;
        }
      }

      setState({ status: "running" });
      setRunStartedAt(Date.now());

      if (plan.mode === "single") {
        try {
          const result = await sqlApi.runSql(connectionId, plan.sql, "user");
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
              message: err.mysql?.message ?? err.message,
              code: err.mysql?.code ?? null,
              position: err.mysql?.position ?? null,
            },
          });
        }
        setRunStartedAt(null);
        return;
      }

      // Multi-statement run.
      try {
        const rawOutcomes = await sqlApi.runSqlMany(
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
        const synthetic: StatementOutcome[] = plan.statements.map((_, idx) => {
          if (idx === 0) {
            return {
              statement_index: idx,
              outcome: "err" as const,
              error: {
                message: err.mysql?.message ?? err.message,
                code: err.mysql?.code ?? null,
                position: err.mysql?.position ?? null,
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
  const ok = state.outcomes.filter((o) => o.outcome === "ok").length;
  const err = state.outcomes.filter((o) => o.outcome === "err").length;
  return `${ok} ok · ${err} err · ${state.outcomes.length} statements`;
}
