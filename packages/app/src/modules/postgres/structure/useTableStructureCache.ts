import { useCallback, useRef, useState } from "react";
import { schemaApi } from "../schema/api";
import type { TableStructureResult } from "../schema/types";
import { AppError } from "@/platform/errors/AppError";

export type CacheStatus = "idle" | "loading" | "ready" | "error";

export interface CacheState {
  status: CacheStatus;
  response: TableStructureResult | null;
  error: AppError | null;
}

export interface TableStructureCache {
  state: CacheState;
  ensureLoaded: (origin: "auto" | "user") => Promise<void>;
  refresh: (origin: "auto" | "user") => Promise<void>;
}

const initialState: CacheState = {
  status: "idle",
  response: null,
  error: null,
};

/**
 * Per-tab cache for the Structure subtab response. Two callers (Structure
 * and Raw subtabs) read from the same cache, so a concurrent first-mount of
 * both does not double-fetch — the first to call `ensureLoaded` claims the
 * in-flight promise.
 *
 * The cache is keyed on `(connectionId, schema, relation)` and resets in
 * render when the key changes. `TabContent` reuses the same `TableViewerTab`
 * instance across `postgres-table-data` tabs, so a tab switch shows up here
 * as a prop change, not a remount.
 */
export function useTableStructureCache(
  connectionId: string,
  schema: string,
  relation: string,
): TableStructureCache {
  const key = `${connectionId}|${schema}|${relation}`;
  const [lastKey, setLastKey] = useState(key);
  const [state, setState] = useState<CacheState>(initialState);
  const inflightRef = useRef<Promise<void> | null>(null);
  const generationRef = useRef(0);

  // Render-phase reset (React's "storing information from previous renders"
  // pattern). Triggers a re-render with `state = initialState` when the key
  // changes.
  if (lastKey !== key) {
    setLastKey(key);
    setState(initialState);
    generationRef.current += 1;
    inflightRef.current = null;
  }

  const dispatch = useCallback(
    async (origin: "auto" | "user") => {
      const gen = generationRef.current;
      try {
        const response = await schemaApi.tableStructure(
          connectionId,
          schema,
          relation,
          origin,
        );
        if (generationRef.current !== gen) return;
        setState({ status: "ready", response, error: null });
      } catch (e) {
        if (generationRef.current !== gen) return;
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        setState((prev) => ({
          status: "error",
          response: prev.response,
          error: err,
        }));
      }
    },
    [connectionId, schema, relation],
  );

  const ensureLoaded = useCallback(
    async (origin: "auto" | "user") => {
      if (state.status === "ready") return;
      if (inflightRef.current) {
        return inflightRef.current;
      }
      setState((prev) => ({ ...prev, status: "loading", error: null }));
      const p = dispatch(origin).finally(() => {
        inflightRef.current = null;
      });
      inflightRef.current = p;
      return p;
    },
    [state.status, dispatch],
  );

  const refresh = useCallback(
    async (origin: "auto" | "user") => {
      // Refresh always dispatches a new call. We don't dedup against the
      // current in-flight promise: a refresh during a load is rare, and the
      // last-write-wins shape avoids stale-response races inside `dispatch`.
      setState((prev) => ({ ...prev, status: "loading", error: null }));
      await dispatch(origin);
    },
    [dispatch],
  );

  return { state, ensureLoaded, refresh };
}
