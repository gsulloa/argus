/**
 * MSSQL useTableData — mirrors MySQL's useTableData.ts.
 * Pagination (offset+limit, default 1000, cap 5000), ordering, filter state.
 * Cold-load race protection: rows + columns are cleared simultaneously on new query.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppError } from "@/platform/errors/AppError";
import { dataApi } from "./api";
import {
  modelToPayload,
  type CellValue,
  type FilterModel,
  type RelationKind,
} from "./types";
import type { ColumnInfo, OrderBy, QueryResult } from "../types";

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export const DEFAULT_PAGE_SIZE = 1000;
export const MAX_PAGE_SIZE = 5000;

type Status =
  | { state: "idle" }
  | { state: "loading-first" }
  | { state: "ready" }
  | { state: "loading-next" }
  | { state: "next-error"; error: AppError }
  | { state: "error"; error: AppError };

interface State {
  rows: CellValue[][];
  columns: ColumnInfo[];
  status: Status;
  queryMs: number | null;
  highestLoadedPage: number;
  reachedEnd: boolean;
  truncatedColumns: Set<string>;
}

type Action =
  | { type: "reset" }
  | { type: "first-loading" }
  | { type: "first-loaded"; result: QueryResult; pageSize: number }
  | { type: "first-error"; error: AppError }
  | { type: "next-loading" }
  | { type: "next-loaded"; result: QueryResult; pageSize: number }
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
      return initialState();
    case "first-loading":
      // Cold-load race protection: clear rows + columns simultaneously.
      return {
        ...state,
        rows: [],
        columns: [],
        status: { state: "loading-first" },
      };
    case "first-loaded":
      return {
        ...state,
        rows: action.result.rows as CellValue[][],
        columns: action.result.columns,
        queryMs: action.result.query_ms,
        highestLoadedPage: 1,
        reachedEnd: action.result.rows.length < action.pageSize,
        truncatedColumns: new Set<string>(action.result.truncated_columns),
        status: { state: "ready" },
      };
    case "first-error":
      return { ...state, status: { state: "error", error: action.error } };
    case "next-loading":
      return { ...state, status: { state: "loading-next" } };
    case "next-loaded": {
      const newRows = [...state.rows, ...(action.result.rows as CellValue[][])];
      const truncated = new Set(state.truncatedColumns);
      for (const c of action.result.truncated_columns) truncated.add(c);
      return {
        ...state,
        rows: newRows,
        queryMs: state.queryMs,
        highestLoadedPage: state.highestLoadedPage + 1,
        reachedEnd: action.result.rows.length < action.pageSize,
        truncatedColumns: truncated,
        status: { state: "ready" },
      };
    }
    case "next-error":
      return { ...state, status: { state: "next-error", error: action.error } };
    case "clear-next-error":
      return { ...state, status: { state: "ready" } };
    default:
      return state;
  }
}

export interface UseTableDataResult {
  rows: CellValue[][];
  columns: ColumnInfo[];
  isLoading: boolean;
  isLoadingNext: boolean;
  isReady: boolean;
  error: AppError | null;
  nextError: AppError | null;
  reachedEnd: boolean;
  queryMs: number | null;
  truncatedColumns: Set<string>;
  pageSize: number;
  setPageSize(n: number): void;
  orderBy: OrderBy[];
  setOrderBy(o: OrderBy[]): void;
  filterModel: FilterModel;
  setFilterModel(m: FilterModel): void;
  refresh(): void;
  loadNextPage(): void;
  clearNextError(): void;
}

export interface UseTableDataArgs {
  connectionId: string;
  schema: string;
  relation: string;
  relationKind: RelationKind;
  initialPageSize?: number;
  initialOrderBy?: OrderBy[];
  /**
   * When `false`, defer the first-page auto-fetch. Callers use this to wait for
   * the async PK lookup so the first fetch carries the PK-derived default order
   * instead of burning an empty-order fetch the default would immediately
   * supersede. Defaults to `true`.
   */
  enabled?: boolean;
}

export function useTableData({
  connectionId,
  schema,
  relation,
  // relationKind is reserved for future use (e.g., view-specific queries)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  relationKind: _relationKind,
  initialPageSize = DEFAULT_PAGE_SIZE,
  initialOrderBy = [],
  enabled = true,
}: UseTableDataArgs): UseTableDataResult {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const [pageSize, setPageSizeRaw] = useReducer(
    (_: number, n: number) => Math.min(Math.max(1, n), MAX_PAGE_SIZE),
    initialPageSize,
  );
  const [orderBy, setOrderByRaw] = useReducer(
    (_: OrderBy[], o: OrderBy[]) => o,
    initialOrderBy,
  );
  const [filterModel, setFilterModelRaw] = useReducer(
    (_: FilterModel, m: FilterModel) => m,
    { rows: [], combinator: "AND" as const },
  );
  const setPageSize = useCallback((n: number) => setPageSizeRaw(n), []);
  const setFilterModel = useCallback((m: FilterModel) => setFilterModelRaw(m), []);

  // Re-seed `orderBy` from a freshly-resolved `initialOrderBy` (e.g. the
  // PK-descending default that arrives after the async PK lookup completes),
  // but only before the first fetch and only while the user has not chosen an
  // order. Adjusting state during render (React's documented pattern) makes the
  // new order visible to the auto-fetch effect in the same commit, so the
  // relation opens with a single fetch carrying the correct order.
  const userTouchedOrderRef = useRef(false);
  const hasFetchedRef = useRef(false);
  const initialOrderKey = JSON.stringify(initialOrderBy);
  const [seededOrderKey, setSeededOrderKey] = useState(initialOrderKey);
  if (
    seededOrderKey !== initialOrderKey &&
    !userTouchedOrderRef.current &&
    !hasFetchedRef.current
  ) {
    setSeededOrderKey(initialOrderKey);
    setOrderByRaw(initialOrderBy);
  }
  const setOrderBy = useCallback((o: OrderBy[]) => {
    userTouchedOrderRef.current = true;
    setOrderByRaw(o);
  }, []);

  // Stable generation counter to detect stale fetches
  const fetchGenRef = useRef(0);

  const fetchFirstPage = useCallback(async () => {
    if (!isTauriRuntime()) return;
    hasFetchedRef.current = true;
    const gen = ++fetchGenRef.current;
    dispatch({ type: "first-loading" });
    try {
      const filterPayload = modelToPayload(filterModel);
      const result = await dataApi.queryTable(
        connectionId,
        schema,
        relation,
        {
          limit: pageSize,
          offset: 0,
          order_by: orderBy.length > 0 ? orderBy : undefined,
          ...filterPayload,
        },
        "auto",
      );
      if (fetchGenRef.current !== gen) return;
      dispatch({ type: "first-loaded", result, pageSize });
    } catch (e) {
      if (fetchGenRef.current !== gen) return;
      const err = e instanceof AppError ? e : new AppError("Internal", String(e));
      dispatch({ type: "first-error", error: err });
    }
  }, [connectionId, schema, relation, pageSize, orderBy, filterModel]);

  // Auto-fetch on mount and when key props change.
  const depsKey = `${connectionId}/${schema}/${relation}/${pageSize}/${JSON.stringify(orderBy)}/${JSON.stringify(filterModel)}`;
  const depsKeyRef = useRef(depsKey);
  useEffect(() => {
    if (!enabled) return;
    if (depsKeyRef.current === depsKey && stateRef.current.status.state !== "idle") return;
    depsKeyRef.current = depsKey;
    void fetchFirstPage();
  }, [depsKey, fetchFirstPage, enabled]);

  // refresh() is the explicit Apply gesture handler. It MUST unconditionally
  // reset the buffer and issue a new first-page fetch. It MUST NOT be routed
  // through the depsKey auto-fetch effect — that effect's guard
  // (`depsKeyRef.current === depsKey`) would swallow the fetch when filterModel
  // is unchanged. Calling dispatch("reset") + fetchFirstPage() directly
  // bypasses that guard and guarantees a network round-trip.
  // see openspec/changes/fix-reapply-same-filter-refetch/specs/mssql-data-grid
  // "Filter Apply always refetches" requirement.
  const refresh = useCallback(() => {
    dispatch({ type: "reset" });
    void fetchFirstPage();
  }, [fetchFirstPage]);

  const loadNextPage = useCallback(async () => {
    const s = stateRef.current;
    if (s.status.state !== "ready" || s.reachedEnd) return;
    if (!isTauriRuntime()) return;
    const gen = fetchGenRef.current;
    dispatch({ type: "next-loading" });
    try {
      const filterPayload = modelToPayload(filterModel);
      const result = await dataApi.queryTable(
        connectionId,
        schema,
        relation,
        {
          limit: pageSize,
          offset: s.highestLoadedPage * pageSize,
          order_by: orderBy.length > 0 ? orderBy : undefined,
          ...filterPayload,
        },
        "auto",
      );
      if (fetchGenRef.current !== gen) return;
      dispatch({ type: "next-loaded", result, pageSize });
    } catch (e) {
      if (fetchGenRef.current !== gen) return;
      const err = e instanceof AppError ? e : new AppError("Internal", String(e));
      dispatch({ type: "next-error", error: err });
    }
  }, [connectionId, schema, relation, pageSize, orderBy, filterModel]);

  const clearNextError = useCallback(() => dispatch({ type: "clear-next-error" }), []);

  const isLoading = state.status.state === "loading-first";
  const isLoadingNext = state.status.state === "loading-next";
  const isReady = state.status.state === "ready";
  const error =
    state.status.state === "error" ? state.status.error : null;
  const nextError =
    state.status.state === "next-error" ? state.status.error : null;

  return useMemo(
    () => ({
      rows: state.rows,
      columns: state.columns,
      isLoading,
      isLoadingNext,
      isReady,
      error,
      nextError,
      reachedEnd: state.reachedEnd,
      queryMs: state.queryMs,
      truncatedColumns: state.truncatedColumns,
      pageSize,
      setPageSize,
      orderBy,
      setOrderBy,
      filterModel,
      setFilterModel,
      refresh,
      loadNextPage,
      clearNextError,
    }),
    [
      state.rows,
      state.columns,
      isLoading,
      isLoadingNext,
      isReady,
      error,
      nextError,
      state.reachedEnd,
      state.queryMs,
      state.truncatedColumns,
      pageSize,
      setPageSize,
      orderBy,
      setOrderBy,
      filterModel,
      setFilterModel,
      refresh,
      loadNextPage,
      clearNextError,
    ],
  );
}
