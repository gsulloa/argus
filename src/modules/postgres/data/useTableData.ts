import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { AppError } from "@/platform/errors/AppError";
import { isPostgresTimeout } from "../errors";
import { globalSchemaCache } from "../schema/globalSchemaCache";
import { dataApi } from "./api";
import {
  modelToPayload,
  type CellValue,
  type DataColumn,
  type FilterModel,
  type OrderBy,
  type QueryTableResult,
} from "./types";

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

type Status =
  | { state: "idle" }
  | { state: "loading-first" }
  | { state: "loading-first-retrying" }
  | { state: "ready" }
  | { state: "loading-next" }
  | { state: "next-error"; error: AppError }
  | { state: "error"; error: AppError };

interface State {
  rows: CellValue[][];
  columns: DataColumn[];
  status: Status;
  /** Page-1 query duration. Cleared when the buffer resets. */
  queryMs: number | null;
  /** Highest 1-based page number we've appended. */
  highestLoadedPage: number;
  /** True when the most recent page came back with fewer than `pageSize` rows. */
  reachedEnd: boolean;
  truncatedColumns: Set<string>;
}

type Action =
  | { type: "reset"; pageSize: number }
  | { type: "first-loading"; isRetry: boolean }
  | { type: "first-loaded"; result: QueryTableResult; pageSize: number }
  | { type: "first-error"; error: AppError }
  | { type: "next-loading" }
  | { type: "next-loaded"; result: QueryTableResult; pageSize: number }
  | { type: "next-error"; error: AppError }
  | { type: "clear-next-error" };

function initialState(): State {
  return {
    rows: [],
    columns: [],
    status: { state: "idle" },
    queryMs: null,
    highestLoadedPage: 0,
    reachedEnd: false,
    truncatedColumns: new Set(),
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "reset":
      return {
        rows: [],
        columns: [],
        status: { state: "idle" },
        queryMs: null,
        highestLoadedPage: 0,
        reachedEnd: false,
        truncatedColumns: new Set(),
      };
    case "first-loading":
      return {
        ...state,
        status: action.isRetry
          ? { state: "loading-first-retrying" }
          : { state: "loading-first" },
      };
    case "first-loaded": {
      const truncated = new Set<string>(action.result.truncated_columns);
      return {
        ...state,
        rows: action.result.rows,
        columns: action.result.columns,
        queryMs: action.result.query_ms,
        highestLoadedPage: 1,
        reachedEnd: action.result.rows.length < action.pageSize,
        truncatedColumns: truncated,
        status: { state: "ready" },
      };
    }
    case "first-error":
      return {
        ...state,
        status: { state: "error", error: action.error },
      };
    case "next-loading":
      return { ...state, status: { state: "loading-next" } };
    case "next-loaded": {
      const merged = new Set(state.truncatedColumns);
      for (const c of action.result.truncated_columns) merged.add(c);
      return {
        ...state,
        rows: state.rows.concat(action.result.rows),
        queryMs: action.result.query_ms,
        highestLoadedPage: state.highestLoadedPage + 1,
        reachedEnd: action.result.rows.length < action.pageSize,
        truncatedColumns: merged,
        status: { state: "ready" },
      };
    }
    case "next-error":
      return {
        ...state,
        status: { state: "next-error", error: action.error },
      };
    case "clear-next-error":
      return state.status.state === "next-error"
        ? { ...state, status: { state: "ready" } }
        : state;
    default:
      return state;
  }
}

function asAppError(e: unknown): AppError {
  return e instanceof AppError ? e : new AppError("Internal", String(e));
}

export interface UseTableDataParams {
  connectionId: string;
  schema: string;
  relation: string;
  pageSize: number;
  orderBy: OrderBy[];
  /**
   * Applied (committed) filter model. Edits to the bar's draft do not flow
   * through here — only the explicit Apply commits.
   */
  applied: FilterModel;
  /**
   * When `false`, defer the first-page fetch (the buffer stays in
   * `loading-first`). Used by callers that need to wait for persisted state
   * to load before issuing the first query — otherwise we'd burn a fetch
   * with `applied = empty` that the persisted value would immediately
   * supersede. Defaults to `true`.
   */
  enabled?: boolean;
  /**
   * Monotonically-advancing token incremented on every user-initiated Apply
   * gesture (Apply All, per-row Apply, ⌘↵, ⇧⌘↵). Including the token in
   * `depsKey` ensures the fetch fires even when the resulting `applied` value
   * is structurally equal to its previous value. Callers MUST advance this
   * token on every Apply commit. Defaults to `0`.
   */
  applyToken?: number;
}

export interface UseTableDataResult {
  rows: CellValue[][];
  columns: DataColumn[];
  status: Status["state"];
  error: AppError | null;
  queryMs: number | null;
  highestLoadedPage: number;
  reachedEnd: boolean;
  truncatedColumns: Set<string>;
  loadNextPage(): void;
  retryNextPage(): void;
  retryFirstPage(): void;
}

/**
 * Buffered data hook for the table viewer. Owns LIMIT/OFFSET pagination,
 * one-shot auto-retry on SQLSTATE 57014 for the *first* page, and inline
 * retry for later pages without resetting the buffer. Resets the buffer
 * whenever `pageSize`, `orderBy`, or `filters` change.
 */
export function useTableData(params: UseTableDataParams): UseTableDataResult {
  const {
    connectionId,
    schema,
    relation,
    pageSize,
    orderBy,
    applied,
    enabled = true,
    applyToken = 0,
  } = params;

  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  // Latest values for closures — avoids stale captures.
  const stateRef = useRef(state);
  stateRef.current = state;
  const orderByRef = useRef(orderBy);
  orderByRef.current = orderBy;
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  const pageSizeRef = useRef(pageSize);
  pageSizeRef.current = pageSize;

  // Stable JSON keys so effects don't churn on identity-equal-but-deep-equal arrays.
  const orderKey = useMemo(() => JSON.stringify(orderBy), [orderBy]);
  const filtersKey = useMemo(() => JSON.stringify(applied), [applied]);

  // Cancellation identity for in-flight fetches. The depsKey is the canonical
  // identity of "which fetch this is" and is advanced synchronously during
  // render (mirroring `pageSizeRef`). Comparing the captured key against the
  // ref after each await detects stale responses without falling out of phase
  // with the params under React 18 batching.
  //
  // applyToken is included so that pressing Apply with a structurally-equal
  // filter model still invalidates the key and triggers a refetch.
  // see openspec/changes/fix-reapply-same-filter-refetch/specs/postgres-data-grid
  // "Filter Apply always refetches" requirement.
  const depsKey = `${connectionId}|${schema}|${relation}|${pageSize}|${orderKey}|${filtersKey}|${applyToken}`;
  const paramsKeyRef = useRef(depsKey);
  paramsKeyRef.current = depsKey;

  // Reset buffer when paging inputs actually change. The fingerprint ref makes
  // this effect idempotent under React 18 StrictMode (which runs effects
  // mount → cleanup → mount on initial render). On first mount the ref is
  // initialized to the current deps, so the effect's first body and its
  // dev-only replay both compare equal and return without dispatching.
  const lastDepsKeyRef = useRef(depsKey);
  useEffect(() => {
    if (lastDepsKeyRef.current === depsKey) return;
    lastDepsKeyRef.current = depsKey;
    dispatch({ type: "reset", pageSize });
  }, [depsKey, pageSize]);

  const fetchFirstPage = useCallback(async () => {
    if (!isTauriRuntime()) return;
    const captured = paramsKeyRef.current;
    dispatch({ type: "first-loading", isRetry: false });
    try {
      const result = await dataApi.queryTable(
        connectionId,
        schema,
        relation,
        {
          limit: pageSizeRef.current,
          offset: 0,
          order_by: orderByRef.current,
          ...modelToPayload(appliedRef.current),
        },
        "user",
      );
      if (paramsKeyRef.current !== captured) return;
      globalSchemaCache.recordColumns(connectionId, schema, relation, result.columns);
      dispatch({ type: "first-loaded", result, pageSize: pageSizeRef.current });
    } catch (e) {
      const err = asAppError(e);
      if (paramsKeyRef.current !== captured) return;
      if (isPostgresTimeout(err)) {
        // Auto-retry the first page exactly once.
        dispatch({ type: "first-loading", isRetry: true });
        try {
          const result = await dataApi.queryTable(
            connectionId,
            schema,
            relation,
            {
              limit: pageSizeRef.current,
              offset: 0,
              order_by: orderByRef.current,
              ...modelToPayload(appliedRef.current),
            },
            "user",
          );
          if (paramsKeyRef.current !== captured) return;
          globalSchemaCache.recordColumns(
            connectionId,
            schema,
            relation,
            result.columns,
          );
          dispatch({
            type: "first-loaded",
            result,
            pageSize: pageSizeRef.current,
          });
          return;
        } catch (retryErr) {
          const rerr = asAppError(retryErr);
          if (paramsKeyRef.current !== captured) return;
          dispatch({ type: "first-error", error: rerr });
          return;
        }
      }
      dispatch({ type: "first-error", error: err });
    }
  }, [connectionId, schema, relation]);

  // Trigger the first-page fetch when we transition to idle after a reset.
  // Gated by `enabled` so callers can defer the first fetch (e.g. until
  // persisted filter/orderBy have loaded from disk). Re-fires whenever
  // depsKey changes for an enabled, non-terminal state (the reset action
  // transitions status back to `idle` so this effect picks up).
  useEffect(() => {
    if (!enabled) return;
    if (state.status.state !== "idle") return;
    void fetchFirstPage();
  }, [enabled, state.status.state, depsKey, fetchFirstPage]);

  const fetchNextPage = useCallback(async () => {
    if (!isTauriRuntime()) return;
    const cur = stateRef.current;
    if (cur.reachedEnd) return;
    const offset = cur.rows.length;
    const captured = paramsKeyRef.current;
    dispatch({ type: "next-loading" });
    try {
      const result = await dataApi.queryTable(
        connectionId,
        schema,
        relation,
        {
          limit: pageSizeRef.current,
          offset,
          order_by: orderByRef.current,
          ...modelToPayload(appliedRef.current),
        },
        "user",
      );
      if (paramsKeyRef.current !== captured) return;
      dispatch({ type: "next-loaded", result, pageSize: pageSizeRef.current });
    } catch (e) {
      if (paramsKeyRef.current !== captured) return;
      dispatch({ type: "next-error", error: asAppError(e) });
    }
  }, [connectionId, schema, relation]);

  const loadNextPage = useCallback(() => {
    const s = stateRef.current.status.state;
    // Idempotent under double-fire: only kick off when ready.
    if (s !== "ready") return;
    if (stateRef.current.reachedEnd) return;
    void fetchNextPage();
  }, [fetchNextPage]);

  const retryNextPage = useCallback(() => {
    if (stateRef.current.status.state !== "next-error") return;
    dispatch({ type: "clear-next-error" });
    void fetchNextPage();
  }, [fetchNextPage]);

  const retryFirstPage = useCallback(() => {
    void fetchFirstPage();
  }, [fetchFirstPage]);

  const error =
    state.status.state === "error" || state.status.state === "next-error"
      ? state.status.error
      : null;

  return {
    rows: state.rows,
    columns: state.columns,
    status: state.status.state,
    error,
    queryMs: state.queryMs,
    highestLoadedPage: state.highestLoadedPage,
    reachedEnd: state.reachedEnd,
    truncatedColumns: state.truncatedColumns,
    loadNextPage,
    retryNextPage,
    retryFirstPage,
  };
}
