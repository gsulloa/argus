import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { AppError } from "@/platform/errors/AppError";
import { isPostgresTimeout } from "../errors";
import { dataApi } from "./api";
import type {
  CellValue,
  DataColumn,
  Filter,
  OrderBy,
  QueryTableResult,
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
  /** Bumped whenever the buffer resets — used to invalidate in-flight loaders. */
  generation: number;
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
    generation: 0,
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
        generation: state.generation + 1,
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
  filters: Filter[];
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
  const { connectionId, schema, relation, pageSize, orderBy, filters } = params;

  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  // Latest values for closures — avoids stale captures.
  const stateRef = useRef(state);
  stateRef.current = state;
  const orderByRef = useRef(orderBy);
  orderByRef.current = orderBy;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const pageSizeRef = useRef(pageSize);
  pageSizeRef.current = pageSize;

  // Stable JSON keys so effects don't churn on identity-equal-but-deep-equal arrays.
  const orderKey = useMemo(() => JSON.stringify(orderBy), [orderBy]);
  const filtersKey = useMemo(() => JSON.stringify(filters), [filters]);

  // Reset buffer whenever paging inputs change.
  useEffect(() => {
    dispatch({ type: "reset", pageSize });
  }, [connectionId, schema, relation, pageSize, orderKey, filtersKey]);

  const fetchFirstPage = useCallback(
    async (generation: number) => {
      if (!isTauriRuntime()) return;
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
            filters: filtersRef.current,
          },
          "user",
        );
        if (stateRef.current.generation !== generation) return;
        dispatch({ type: "first-loaded", result, pageSize: pageSizeRef.current });
      } catch (e) {
        const err = asAppError(e);
        if (stateRef.current.generation !== generation) return;
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
                filters: filtersRef.current,
              },
              "user",
            );
            if (stateRef.current.generation !== generation) return;
            dispatch({
              type: "first-loaded",
              result,
              pageSize: pageSizeRef.current,
            });
            return;
          } catch (retryErr) {
            const rerr = asAppError(retryErr);
            if (stateRef.current.generation !== generation) return;
            dispatch({ type: "first-error", error: rerr });
            return;
          }
        }
        dispatch({ type: "first-error", error: err });
      }
    },
    [connectionId, schema, relation],
  );

  // Trigger the first-page fetch when we transition to idle after a reset.
  useEffect(() => {
    if (state.status.state !== "idle") return;
    void fetchFirstPage(state.generation);
  }, [state.status.state, state.generation, fetchFirstPage]);

  const fetchNextPage = useCallback(
    async (generation: number) => {
      if (!isTauriRuntime()) return;
      const cur = stateRef.current;
      if (cur.reachedEnd) return;
      const offset = cur.rows.length;
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
            filters: filtersRef.current,
          },
          "user",
        );
        if (stateRef.current.generation !== generation) return;
        dispatch({ type: "next-loaded", result, pageSize: pageSizeRef.current });
      } catch (e) {
        if (stateRef.current.generation !== generation) return;
        dispatch({ type: "next-error", error: asAppError(e) });
      }
    },
    [connectionId, schema, relation],
  );

  const loadNextPage = useCallback(() => {
    const s = stateRef.current.status.state;
    // Idempotent under double-fire: only kick off when ready.
    if (s !== "ready") return;
    if (stateRef.current.reachedEnd) return;
    void fetchNextPage(stateRef.current.generation);
  }, [fetchNextPage]);

  const retryNextPage = useCallback(() => {
    if (stateRef.current.status.state !== "next-error") return;
    dispatch({ type: "clear-next-error" });
    void fetchNextPage(stateRef.current.generation);
  }, [fetchNextPage]);

  const retryFirstPage = useCallback(() => {
    void fetchFirstPage(stateRef.current.generation);
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
