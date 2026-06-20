/**
 * CloudWatch Logs Insights query run state machine.
 *
 * Assembles { logGroupIdentifiers, startTime, endTime, queryString, limit },
 * calls cloudwatchApi.runInsights, exposes QUEUED/RUNNING state + cancel.
 *
 * The cloudwatch:query-started event from the backend carries the query_id
 * which is used to cancel via cloudwatch_cancel_insights.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AppError } from "@/platform/errors/AppError";
import { cloudwatchApi } from "../api";
import { resolveTimeRange } from "./Toolbar";
import type { InsightsResult, TimeRange } from "../types";

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export interface InsightsRunState {
  status: "idle" | "running";
  result: InsightsResult | null;
  error: string | null;
}

export interface UseInsightsRunResult {
  state: InsightsRunState;
  summary: string | null;
  run(args: {
    connectionId: string;
    logGroupIdentifiers: string[];
    timeRange: TimeRange;
    queryString: string;
    limit?: number;
  }): Promise<void>;
  cancel(): void;
  reset(): void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useInsightsQueryRun(): UseInsightsRunResult {
  const [state, setState] = useState<InsightsRunState>({
    status: "idle",
    result: null,
    error: null,
  });

  // Tracks the in-flight query_id for cancellation (set by backend event)
  const activeQueryRef = useRef<{
    connectionId: string;
    queryId: string;
  } | null>(null);

  const cancelRequestedRef = useRef(false);

  // Listen for cloudwatch:query-started event to capture query_id
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<{ connection_id: string; query_id: string }>(
      "cloudwatch:query-started",
      (event) => {
        activeQueryRef.current = {
          connectionId: event.payload.connection_id,
          queryId: event.payload.query_id,
        };
      },
    ).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const reset = useCallback(() => {
    setState({ status: "idle", result: null, error: null });
    activeQueryRef.current = null;
    cancelRequestedRef.current = false;
  }, []);

  const cancel = useCallback(() => {
    cancelRequestedRef.current = true;
    const active = activeQueryRef.current;
    if (active) {
      void cloudwatchApi.cancelInsights(active.connectionId, active.queryId).catch((e) => {
        console.warn("[cloudwatch] cancel failed:", e);
      });
    }
  }, []);

  const run = useCallback(
    async (args: {
      connectionId: string;
      logGroupIdentifiers: string[];
      timeRange: TimeRange;
      queryString: string;
      limit?: number;
    }) => {
      const { connectionId, logGroupIdentifiers, timeRange, queryString, limit } = args;

      if (logGroupIdentifiers.length === 0) {
        setState((s) => ({ ...s, error: "Select at least one log group." }));
        return;
      }

      if (!queryString.trim()) {
        setState((s) => ({ ...s, error: "Query string is empty." }));
        return;
      }

      cancelRequestedRef.current = false;
      activeQueryRef.current = null;
      setState({ status: "running", result: null, error: null });

      // Resolve time range at run time
      const { startTime, endTime } = resolveTimeRange(timeRange);

      try {
        const result = await cloudwatchApi.runInsights(
          connectionId,
          logGroupIdentifiers,
          startTime,
          endTime,
          queryString,
          limit,
          "user",
        );
        setState({ status: "idle", result, error: null });
      } catch (e) {
        if (cancelRequestedRef.current) {
          // Cancelled — reset to idle
          setState({ status: "idle", result: null, error: null });
        } else {
          const err = e instanceof AppError ? e : new AppError("Internal", String(e));
          setState({
            status: "idle",
            result: null,
            error: err.aws?.message ?? err.message,
          });
        }
      } finally {
        activeQueryRef.current = null;
      }
    },
    [],
  );

  const summary = summarize(state);
  return { state, summary, run, cancel, reset };
}

// ---------------------------------------------------------------------------
// Summary helper
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function summarize(state: InsightsRunState): string | null {
  if (state.status === "running") return "Running…";
  if (state.error) return `error · ${state.error}`;
  if (!state.result) return null;
  const r = state.result;
  const rows = r.rows.length;
  const trunc = r.truncated ? " (truncated)" : "";
  const scanned = r.bytes_scanned > 0 ? ` · ${formatBytes(r.bytes_scanned)} scanned` : "";
  const matched = r.records_matched > 0 ? ` · ${r.records_matched.toLocaleString()} matched` : "";
  return `${rows} rows · ${r.query_ms} ms${trunc}${matched}${scanned}`;
}
