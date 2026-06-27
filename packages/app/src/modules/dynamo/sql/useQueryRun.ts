/**
 * DynamoDB PartiQL query run state machine.
 *
 * Mirrors Athena's useQueryRun but uses dynamoRunPartiql / dynamoRunPartiqlMany.
 * Splits multi-statement bodies on ";" (same helper as MySQL/Athena).
 *
 * NOTE: unlike the SQL engines (Postgres/MySQL/MSSQL) and the async engines
 * (Athena/CloudWatch), DynamoDB exposes no server-side abort API for
 * ExecuteStatement/scan/query, so there is intentionally no Stop/cancel
 * affordance here (issue #193). A PartiQL run cannot be cancelled mid-flight.
 */

import { useCallback, useState } from "react";
import { AppError } from "@/platform/errors/AppError";
import { dynamoRunPartiql, dynamoRunPartiqlMany } from "./api";
import { splitStatements, getStatementUnderCursor } from "@/modules/mysql/sql/splitStatements";
import type { RunPartiQLResult, PartiQLStatementOutcome } from "./api";

export type { RunPartiQLResult, PartiQLStatementOutcome };

export interface SingleRunState {
  mode: "single";
  sql: string;
  startOffset: number;
  result: RunPartiQLResult | null;
  error: { message: string; code: string | null; position: number | null } | null;
}

export interface MultiRunState {
  mode: "multi";
  statements: import("@/modules/mysql/sql/splitStatements").Statement[];
  outcomes: PartiQLStatementOutcome[];
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

export function useDynamoQueryRun(): UseQueryRunResult {
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
          const result = await dynamoRunPartiql(connectionId, plan.sql, "user");
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
        const { outcomes } = await dynamoRunPartiqlMany(
          connectionId,
          plan.statements.map((s) => s.sql),
          "user",
        );
        setState({
          status: "done",
          mode: "multi",
          statements: plan.statements,
          outcomes,
        });
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        const synthetic: PartiQLStatementOutcome[] = plan.statements.map((s, idx) => {
          if (idx === 0) {
            return {
              index: idx,
              statement: s.sql,
              outcome: "err" as const,
              error: {
                message: err.aws?.message ?? err.message,
              },
            };
          }
          return { index: idx, statement: s.sql, outcome: "skipped" as const };
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

function formatCapacity(cap: unknown): string | null {
  if (!cap || typeof cap !== "object") return null;
  const obj = cap as Record<string, unknown>;
  const cu = typeof obj.CapacityUnits === "number" ? obj.CapacityUnits : null;
  if (cu === null) return null;
  return `${cu} CU`;
}

function summarize(state: RunState): string | null {
  if (state.status === "running") return "Running…";
  if (state.status !== "done") return null;
  if (state.mode === "single") {
    if (state.error) return `error · ${state.error.code ?? "—"}`;
    if (!state.result) return null;
    const cap = formatCapacity(state.result.consumed_capacity);
    const capStr = cap ? ` · ${cap}` : "";
    if (state.result.kind === "rows") {
      const trunc = state.result.truncated ? " (truncated)" : "";
      return `${state.result.count} rows · ${state.result.query_ms} ms${trunc}${capStr}`;
    }
    // succeeded
    return `${state.result.statement_type} · ${state.result.query_ms} ms${capStr}`;
  }
  // multi
  const ok = state.outcomes.filter((o) => o.outcome === "ok").length;
  const err = state.outcomes.filter((o) => o.outcome === "err").length;
  return `${ok} ok · ${err} err · ${state.outcomes.length} statements`;
}
