/**
 * DynamoDB Tables Cache Provider
 *
 * Holds per-connection cache state for table names (list) and table descriptions
 * (describe). Exposes hooks for consumers and a describe pipeline with parallelism
 * cap of 8.
 *
 * Architecture:
 *   - useReducer for all cache state transitions
 *   - useEffect for Tauri event subscriptions
 *   - useEffect for describe-pipeline dispatch
 *   - Ref-count per connectionId to track mounted subscribers
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { dynamoApi } from "@/modules/dynamo/api";
import type { AppError } from "@/platform/errors/AppError";
import { dynamoTablesApi } from "./api";
import type { TableDescription } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_INFLIGHT_DESCRIBES = 8;

// ---------------------------------------------------------------------------
// Slot types
// ---------------------------------------------------------------------------

export type TablesSlot =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; names: string[]; next_token?: string; truncated: boolean }
  | { status: "error"; error: AppError };

export type DescribeSlot =
  | { status: "loading" }
  | { status: "ready"; value: TableDescription }
  | { status: "error"; error: AppError };

// ---------------------------------------------------------------------------
// Per-connection cache shape
// ---------------------------------------------------------------------------

interface ConnectionCache {
  tables: TablesSlot;
  describe: Map<string, DescribeSlot>;
  /** Pending describes queue — names waiting to be dispatched. */
  describeQueue: string[];
  /** Number of describe invocations currently in flight. */
  describeInflight: number;
}

// ---------------------------------------------------------------------------
// Full cache state
// ---------------------------------------------------------------------------

type CacheState = Map<string, ConnectionCache>;

// ---------------------------------------------------------------------------
// Reducer actions
// ---------------------------------------------------------------------------

type Action =
  | { type: "listTablesStart"; connectionId: string }
  | { type: "listTablesOk"; connectionId: string; names: string[]; next_token?: string; truncated: boolean }
  | { type: "listTablesErr"; connectionId: string; error: AppError }
  | { type: "loadMoreOk"; connectionId: string; names: string[]; next_token?: string; truncated: boolean }
  | { type: "dropConnection"; connectionId: string }
  | { type: "dropAll" }
  | { type: "describeStart"; connectionId: string; tableName: string }
  | { type: "describeOk"; connectionId: string; tableName: string; value: TableDescription }
  | { type: "describeErr"; connectionId: string; tableName: string; error: AppError }
  | { type: "enqueueDescribe"; connectionId: string; tableName: string }
  | { type: "enqueueDescribeForce"; connectionId: string; tableName: string };

// ---------------------------------------------------------------------------
// Helper: ensure a ConnectionCache entry exists
// ---------------------------------------------------------------------------

function ensureConnection(state: CacheState, connectionId: string): CacheState {
  if (state.has(connectionId)) return state;
  const next = new Map(state);
  next.set(connectionId, {
    tables: { status: "idle" },
    describe: new Map(),
    describeQueue: [],
    describeInflight: 0,
  });
  return next;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function cacheReducer(state: CacheState, action: Action): CacheState {
  switch (action.type) {
    case "listTablesStart": {
      const next = ensureConnection(state, action.connectionId);
      const entry = next.get(action.connectionId)!;
      const updated = new Map(next);
      updated.set(action.connectionId, {
        ...entry,
        tables: { status: "loading" },
      });
      return updated;
    }

    case "listTablesOk": {
      if (!state.has(action.connectionId)) return state;
      const entry = state.get(action.connectionId)!;
      const next = new Map(state);
      next.set(action.connectionId, {
        ...entry,
        tables: {
          status: "ready",
          names: action.names,
          next_token: action.next_token,
          truncated: action.truncated,
        },
      });
      return next;
    }

    case "listTablesErr": {
      if (!state.has(action.connectionId)) return state;
      const entry = state.get(action.connectionId)!;
      const next = new Map(state);
      next.set(action.connectionId, {
        ...entry,
        tables: { status: "error", error: action.error },
      });
      return next;
    }

    case "loadMoreOk": {
      if (!state.has(action.connectionId)) return state;
      const entry = state.get(action.connectionId)!;
      const prevNames =
        entry.tables.status === "ready" ? entry.tables.names : [];
      const next = new Map(state);
      next.set(action.connectionId, {
        ...entry,
        tables: {
          status: "ready",
          names: [...prevNames, ...action.names],
          next_token: action.next_token,
          truncated: action.truncated,
        },
      });
      return next;
    }

    case "dropConnection": {
      if (!state.has(action.connectionId)) return state;
      const next = new Map(state);
      next.delete(action.connectionId);
      return next;
    }

    case "dropAll": {
      if (state.size === 0) return state;
      return new Map();
    }

    case "describeStart": {
      if (!state.has(action.connectionId)) return state;
      const entry = state.get(action.connectionId)!;
      const newDescribe = new Map(entry.describe);
      newDescribe.set(action.tableName, { status: "loading" });
      // Remove from queue, increment inflight
      const newQueue = entry.describeQueue.filter((n) => n !== action.tableName);
      const next = new Map(state);
      next.set(action.connectionId, {
        ...entry,
        describe: newDescribe,
        describeQueue: newQueue,
        describeInflight: entry.describeInflight + 1,
      });
      return next;
    }

    case "describeOk": {
      if (!state.has(action.connectionId)) return state;
      const entry = state.get(action.connectionId)!;
      const newDescribe = new Map(entry.describe);
      newDescribe.set(action.tableName, { status: "ready", value: action.value });
      const next = new Map(state);
      next.set(action.connectionId, {
        ...entry,
        describe: newDescribe,
        describeInflight: Math.max(0, entry.describeInflight - 1),
      });
      return next;
    }

    case "describeErr": {
      if (!state.has(action.connectionId)) return state;
      const entry = state.get(action.connectionId)!;
      const newDescribe = new Map(entry.describe);
      newDescribe.set(action.tableName, { status: "error", error: action.error });
      const next = new Map(state);
      next.set(action.connectionId, {
        ...entry,
        describe: newDescribe,
        describeInflight: Math.max(0, entry.describeInflight - 1),
      });
      return next;
    }

    case "enqueueDescribe": {
      if (!state.has(action.connectionId)) return state;
      const entry = state.get(action.connectionId)!;
      // Idempotent: skip if already cached, loading, or in queue
      if (entry.describe.has(action.tableName)) return state;
      if (entry.describeQueue.includes(action.tableName)) return state;
      const next = new Map(state);
      next.set(action.connectionId, {
        ...entry,
        describeQueue: [...entry.describeQueue, action.tableName],
      });
      return next;
    }

    case "enqueueDescribeForce": {
      // retryDescribe — force re-queue even if already cached or errored
      if (!state.has(action.connectionId)) return state;
      const entry = state.get(action.connectionId)!;
      const newDescribe = new Map(entry.describe);
      // Remove any existing slot (error or ready)
      newDescribe.delete(action.tableName);
      // Ensure not already in queue or loading
      const alreadyQueued = entry.describeQueue.includes(action.tableName);
      const alreadyLoading = entry.describe.get(action.tableName)?.status === "loading";
      if (alreadyQueued || alreadyLoading) {
        // Just clear the slot if needed and leave queue as-is
        const next = new Map(state);
        next.set(action.connectionId, {
          ...entry,
          describe: newDescribe,
        });
        return next;
      }
      const next = new Map(state);
      next.set(action.connectionId, {
        ...entry,
        describe: newDescribe,
        describeQueue: [...entry.describeQueue, action.tableName],
      });
      return next;
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export interface DynamoTableCacheHook {
  tables: TablesSlot;
  describe: Map<string, DescribeSlot>;
  refresh: () => void;
  loadMore: () => void;
  requestDescribe: (tableName: string) => void;
  retryDescribe: (tableName: string) => void;
}

export interface ConnectionCacheSnapshot {
  connectionId: string;
  tables: TablesSlot;
}

export interface RegistryHook {
  /** Read the cache entry for a specific connectionId. */
  getCache: (connectionId: string) => ConnectionCache | undefined;
  /** Refresh the cache for a specific connectionId (drop + re-list). */
  refresh: (connectionId: string) => void;
  /** Drop all caches. */
  dropAll: () => void;
  /**
   * Snapshot of all currently tracked connections and their tables slot.
   * Stable reference changes whenever the cache state changes — use in
   * useEffect dependency arrays to react to any cache change.
   */
  allConnections: ConnectionCacheSnapshot[];
}

interface CacheContextValue {
  state: CacheState;
  dispatch: React.Dispatch<Action>;
  /** Subscribe to a connectionId (returns unsubscribe fn). Fires listTables on first sub. */
  subscribe: (connectionId: string) => () => void;
  refresh: (connectionId: string) => void;
  loadMore: (connectionId: string) => void;
  requestDescribe: (connectionId: string, tableName: string) => void;
  retryDescribe: (connectionId: string, tableName: string) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const CacheContext = createContext<CacheContextValue | null>(null);

// ---------------------------------------------------------------------------
// Helper: Tauri runtime check
// ---------------------------------------------------------------------------

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function DynamoTablesCacheProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(cacheReducer, new Map<string, ConnectionCache>());

  // Ref-count of subscribers per connectionId. Incremented on first
  // useDynamoTableCache(id) subscription, decremented on unmount.
  const subCounts = useRef<Map<string, number>>(new Map());

  // -------------------------------------------------------------------------
  // Core async operations (stable references via useCallback)
  // -------------------------------------------------------------------------

  const doListTables = useCallback(
    async (connectionId: string, origin: "auto" | "user") => {
      dispatch({ type: "listTablesStart", connectionId });
      try {
        const result = await dynamoTablesApi.listTables({ connectionId, origin });
        dispatch({
          type: "listTablesOk",
          connectionId,
          names: result.tables,
          next_token: result.next_token,
          truncated: result.truncated,
        });
      } catch (e) {
        const { toAppError } = await import("@/platform/errors/AppError");
        dispatch({ type: "listTablesErr", connectionId, error: toAppError(e) });
      }
    },
    [],
  );

  const refresh = useCallback(
    (connectionId: string) => {
      dispatch({ type: "dropConnection", connectionId });
      void doListTables(connectionId, "user");
    },
    [doListTables],
  );

  const loadMore = useCallback(
    async (connectionId: string) => {
      const entry = state.get(connectionId);
      if (!entry || entry.tables.status !== "ready" || !entry.tables.truncated) return;
      const { next_token } = entry.tables;
      try {
        const result = await dynamoTablesApi.listTables({
          connectionId,
          paginationToken: next_token,
          origin: "user",
        });
        dispatch({
          type: "loadMoreOk",
          connectionId,
          names: result.tables,
          next_token: result.next_token,
          truncated: result.truncated,
        });
      } catch (e) {
        // loadMore failure is non-fatal; leave existing cache intact.
        console.warn("[dynamo:tables] loadMore failed:", e);
      }
    },
    [state],
  );

  const requestDescribe = useCallback((connectionId: string, tableName: string) => {
    dispatch({ type: "enqueueDescribe", connectionId, tableName });
  }, []);

  const retryDescribe = useCallback((connectionId: string, tableName: string) => {
    dispatch({ type: "enqueueDescribeForce", connectionId, tableName });
  }, []);

  // -------------------------------------------------------------------------
  // subscribe: ref-count bookkeeping + fire initial listTables
  // -------------------------------------------------------------------------

  const subscribe = useCallback(
    (connectionId: string): (() => void) => {
      const counts = subCounts.current;
      const prev = counts.get(connectionId) ?? 0;
      counts.set(connectionId, prev + 1);

      if (prev === 0) {
        // First subscriber for this connectionId — ensure entry exists and fire
        // listTables if cache is idle (or absent).
        dispatch({ type: "listTablesStart", connectionId });
        void doListTables(connectionId, "auto");
      }

      return () => {
        const cur = counts.get(connectionId) ?? 1;
        if (cur <= 1) {
          counts.delete(connectionId);
        } else {
          counts.set(connectionId, cur - 1);
        }
      };
    },
    [doListTables],
  );

  // -------------------------------------------------------------------------
  // Describe pipeline: dispatch describes when inflight < MAX_INFLIGHT_DESCRIBES
  // -------------------------------------------------------------------------

  useEffect(() => {
    for (const [connectionId, entry] of state) {
      const { describeQueue, describeInflight } = entry;
      const slots = MAX_INFLIGHT_DESCRIBES - describeInflight;
      if (slots <= 0 || describeQueue.length === 0) continue;

      const toDispatch = describeQueue.slice(0, slots);
      for (const tableName of toDispatch) {
        dispatch({ type: "describeStart", connectionId, tableName });
        void (async () => {
          try {
            const value = await dynamoTablesApi.describeTable({
              connectionId,
              tableName,
              origin: "auto",
            });
            dispatch({ type: "describeOk", connectionId, tableName, value });
          } catch (e) {
            const { toAppError } = await import("@/platform/errors/AppError");
            dispatch({ type: "describeErr", connectionId, tableName, error: toAppError(e) });
          }
        })();
      }
    }
  });
  // Intentionally no dependency array — runs after every render to drain the
  // queue whenever state changes. The inner dispatch actions are idempotent
  // and only fire when queue is non-empty and there's capacity.

  // -------------------------------------------------------------------------
  // Stable ref to always-current state — used by event handlers that are
  // registered once ([] deps) but must see the latest cache entries.
  // -------------------------------------------------------------------------

  const stateRef = useRef(state);
  stateRef.current = state;

  // -------------------------------------------------------------------------
  // Tauri event: dynamo:active-changed
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    listen<unknown>("dynamo:active-changed", async () => {
      try {
        const active = await dynamoApi.listActive();
        const activeIds = new Set(active.map((c) => c.id));
        // Use stateRef.current so the handler always sees the latest cache,
        // not the empty Map captured at registration time.
        for (const connectionId of stateRef.current.keys()) {
          if (!activeIds.has(connectionId)) {
            dispatch({ type: "dropConnection", connectionId });
          }
        }
      } catch (e) {
        console.warn("[dynamo:tables] active-changed handler failed:", e);
      }
    })
      .then((u) => {
        if (cancelled) {
          u();
        } else {
          unlisten = u;
        }
      })
      .catch(() => {
        // Tauri event subscribe failed — non-fatal
      });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
  // [] is correct — stateRef.current is updated on every render, so the
  // handler always reads the latest cache state without re-registering.

  // -------------------------------------------------------------------------
  // Tauri event: dynamo:credentials-refreshed
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    listen<{ id: string }>("dynamo:credentials-refreshed", (event) => {
      const connectionId = event.payload.id;
      dispatch({ type: "dropConnection", connectionId });

      const hasSubs = (subCounts.current.get(connectionId) ?? 0) > 0;
      if (hasSubs) {
        void doListTables(connectionId, "auto");
      }
    })
      .then((u) => {
        if (cancelled) {
          u();
        } else {
          unlisten = u;
        }
      })
      .catch(() => {
        // Tauri event subscribe failed — non-fatal
      });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [doListTables]);

  // -------------------------------------------------------------------------
  // Context value
  // -------------------------------------------------------------------------

  const value = useMemo<CacheContextValue>(
    () => ({
      state,
      dispatch,
      subscribe,
      refresh,
      loadMore,
      requestDescribe,
      retryDescribe,
    }),
    [state, dispatch, subscribe, refresh, loadMore, requestDescribe, retryDescribe],
  );

  return <CacheContext.Provider value={value}>{children}</CacheContext.Provider>;
}

// ---------------------------------------------------------------------------
// useDynamoTableCache — consumer hook
// ---------------------------------------------------------------------------

export function useDynamoTableCache(connectionId: string): DynamoTableCacheHook {
  const ctx = useContext(CacheContext);
  if (!ctx) {
    throw new Error("useDynamoTableCache must be used inside DynamoTablesCacheProvider");
  }

  const { state, subscribe, refresh: ctxRefresh, loadMore: ctxLoadMore, requestDescribe: ctxRequest, retryDescribe: ctxRetry } = ctx;

  // Subscribe on mount, unsubscribe on unmount or connectionId change.
  useEffect(() => {
    return subscribe(connectionId);
  }, [connectionId, subscribe]);

  const entry = state.get(connectionId);

  const tables: TablesSlot = entry?.tables ?? { status: "idle" };
  const describe: Map<string, DescribeSlot> = entry?.describe ?? new Map();

  const refresh = useCallback(() => ctxRefresh(connectionId), [ctxRefresh, connectionId]);
  const loadMore = useCallback(() => ctxLoadMore(connectionId), [ctxLoadMore, connectionId]);
  const requestDescribe = useCallback(
    (tableName: string) => ctxRequest(connectionId, tableName),
    [ctxRequest, connectionId],
  );
  const retryDescribe = useCallback(
    (tableName: string) => ctxRetry(connectionId, tableName),
    [ctxRetry, connectionId],
  );

  return { tables, describe, refresh, loadMore, requestDescribe, retryDescribe };
}

// ---------------------------------------------------------------------------
// useDynamoTableCacheRegistry — internal hook for palette layer
// ---------------------------------------------------------------------------

export function useDynamoTableCacheRegistry(): RegistryHook {
  const ctx = useContext(CacheContext);
  if (!ctx) {
    throw new Error(
      "useDynamoTableCacheRegistry must be used inside DynamoTablesCacheProvider",
    );
  }

  const { state, refresh, dispatch } = ctx;

  const getCache = useCallback(
    (connectionId: string) => state.get(connectionId),
    [state],
  );

  const dropAll = useCallback(() => {
    dispatch({ type: "dropAll" });
  }, [dispatch]);

  // Stable snapshot array — changes reference whenever state changes.
  const allConnections = useMemo<ConnectionCacheSnapshot[]>(
    () =>
      Array.from(state.entries()).map(([connectionId, entry]) => ({
        connectionId,
        tables: entry.tables,
      })),
    [state],
  );

  return { getCache, refresh, dropAll, allConnections };
}
