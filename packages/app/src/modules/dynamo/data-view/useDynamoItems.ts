/**
 * useDynamoItems — owns Scan/Query dispatch, LastEvaluatedKey pagination,
 * scroll-disable-on-failure, and credentials-refresh auto-resume.
 *
 * Design decisions:
 *
 * - Uses useReducer for the state machine (transitions are complex enough to
 *   warrant it over nested useState setters; mirrors the useTableData pattern
 *   in the Postgres module).
 * - Generation counter prevents stale responses from a previous run() from
 *   overwriting state produced by a later run(). The counter is stored in
 *   both the reducer state (for rendering) AND a separate ref (for immediate
 *   reads inside async closures without waiting for the next render cycle).
 * - The hook does NOT own BuilderState — it accepts builder+describe as
 *   inputs and recompiles on each explicit run()/loadMore() call. Keystrokes
 *   inside QueryBuilder do not cause re-fetches.
 * - Credential-expiration auto-resume listens on the window-level CustomEvent
 *   "dynamo:credentials-refreshed:ui" dispatched by CredentialsRefreshedListener
 *   (src/modules/dynamo/ExpirationListener.tsx). This avoids a second raw
 *   Tauri event subscription and keeps the pattern consistent across the module.
 * - autoScrollDisabled flips to true after any failed load. It resets when:
 *     (a) run() is called, or
 *     (b) the user calls loadMore() manually.
 *   triggerAutoLoadMore() — called by the virtualised table on viewport entry —
 *   is a no-op when autoScrollDisabled is true, guarding silent auto-fire.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { AppError } from "@/platform/errors/AppError";
import { compile } from "./builderCompiler";
import { dynamoScan, dynamoQuery } from "./api";
import type { AttributeMap, BuilderState, Origin } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type DynamoItemsStatus = "idle" | "loading" | "ready" | "error";

interface DynamoItemsState {
  items: AttributeMap[];
  lastEvaluatedKey: AttributeMap | null;
  scannedCount: number;
  status: DynamoItemsStatus;
  error: { message: string; code?: string } | undefined;
  page: number;
  autoScrollDisabled: boolean;
  /**
   * Monotonically-increasing counter bumped on every run() so async closures
   * can detect and discard stale responses.
   */
  generation: number;
}

type DynamoItemsAction =
  | { type: "run-start" }
  | {
      type: "run-success";
      items: AttributeMap[];
      lastEvaluatedKey: AttributeMap | null;
      scannedCount: number;
    }
  | { type: "run-error"; error: { message: string; code?: string } }
  | { type: "load-more-start"; resetScrollDisabled: boolean }
  | {
      type: "load-more-success";
      items: AttributeMap[];
      lastEvaluatedKey: AttributeMap | null;
      scannedCount: number;
    }
  | { type: "load-more-error"; error: { message: string; code?: string } }
  | { type: "reset" }
  | { type: "replace-item"; index: number; next: AttributeMap }
  | { type: "remove-items"; indices: number[] };

function initialState(): DynamoItemsState {
  return {
    items: [],
    lastEvaluatedKey: null,
    scannedCount: 0,
    status: "idle",
    error: undefined,
    page: 0,
    autoScrollDisabled: false,
    generation: 1,
  };
}

function reducer(
  state: DynamoItemsState,
  action: DynamoItemsAction,
): DynamoItemsState {
  switch (action.type) {
    case "run-start":
      return {
        ...state,
        items: [],
        lastEvaluatedKey: null,
        scannedCount: 0,
        status: "loading",
        error: undefined,
        page: 0,
        autoScrollDisabled: false,
        generation: state.generation + 1,
      };

    case "run-success":
      return {
        ...state,
        items: action.items,
        lastEvaluatedKey: action.lastEvaluatedKey,
        scannedCount: action.scannedCount,
        status: "ready",
        error: undefined,
        page: 1,
      };

    case "run-error":
      return {
        ...state,
        status: "error",
        error: action.error,
        autoScrollDisabled: true,
      };

    case "load-more-start":
      return {
        ...state,
        status: "loading",
        error: undefined,
        autoScrollDisabled: action.resetScrollDisabled
          ? false
          : state.autoScrollDisabled,
      };

    case "load-more-success":
      return {
        ...state,
        items: [...state.items, ...action.items],
        lastEvaluatedKey: action.lastEvaluatedKey,
        scannedCount: state.scannedCount + action.scannedCount,
        status: "ready",
        error: undefined,
        page: state.page + 1,
        autoScrollDisabled: false,
      };

    case "load-more-error":
      return {
        ...state,
        status: "error",
        error: action.error,
        autoScrollDisabled: true,
      };

    case "reset":
      return initialState();

    case "replace-item": {
      // Replace a single item in the list at the given index (task 6.3).
      if (action.index < 0 || action.index >= state.items.length) return state;
      const newItems = [...state.items];
      newItems[action.index] = action.next;
      return { ...state, items: newItems };
    }

    case "remove-items": {
      // Remove items at the given indices (task 9.4).
      // Process in descending order so earlier indices remain stable.
      const sorted = [...action.indices].sort((a, b) => b - a);
      const newItems = [...state.items];
      for (const idx of sorted) {
        if (idx >= 0 && idx < newItems.length) {
          newItems.splice(idx, 1);
        }
      }
      return { ...state, items: newItems };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asError(e: unknown): { message: string; code?: string } {
  if (e instanceof AppError) {
    if (e.kind === "Aws" && e.aws) {
      return { message: e.aws.message, code: e.aws.code };
    }
    return { message: e.message };
  }
  if (e instanceof Error) return { message: e.message };
  return { message: String(e) };
}

const EXPIRED_TOKEN_CODES = new Set([
  "ExpiredToken",
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "RequestExpired",
]);

function isExpiredToken(err: { message: string; code?: string }): boolean {
  return err.code !== undefined && EXPIRED_TOKEN_CODES.has(err.code);
}

// ---------------------------------------------------------------------------
// Hook input / output types
// ---------------------------------------------------------------------------

export interface UseDynamoItemsParams {
  connectionId: string;
  tableName: string;
  builder: BuilderState;
  describe: TableDescription;
}

export interface UseDynamoItemsResult {
  items: AttributeMap[];
  lastEvaluatedKey: AttributeMap | null;
  /** Number of items in the current result list (items.length). */
  count: number;
  /** Sum of scanned_count across all loaded pages. */
  scannedCount: number;
  status: DynamoItemsStatus;
  error: { message: string; code?: string } | undefined;
  /** 1-indexed number of pages loaded. 0 when idle or before first run. */
  page: number;
  autoScrollDisabled: boolean;
  /** Explicit user-initiated run — resets pagination. */
  run(origin?: Origin): Promise<void>;
  /**
   * Run with a transient BuilderState override (e.g. per-row Apply).
   * Uses the override state for compilation only; the host's visible builder
   * is NOT mutated. After the run, the hook returns to reading the real builder
   * on the next regular run() call.
   */
  runWithOverride(override: BuilderState, origin?: Origin): Promise<void>;
  /**
   * Manual "load more" — always resets autoScrollDisabled before firing.
   * This is what the toolbar "Load more" button calls.
   */
  loadMore(origin: "user"): Promise<void>;
  /**
   * What the virtualised table calls when the last row enters the viewport.
   * No-op when autoScrollDisabled is true, status is 'loading', or
   * lastEvaluatedKey is null. Does NOT reset autoScrollDisabled itself.
   */
  triggerAutoLoadMore(): void;
  reset(): void;
  /**
   * Replace a single loaded item at `index` with `next`.
   * Used by the inline cell editor on a successful update_item response (task 6.3).
   */
  replaceItem(index: number, next: AttributeMap): void;
  /**
   * Remove items at the given indices from the local list.
   * Used by DeleteConfirmationModal after sequential delete (task 9.4).
   * Indices are processed in descending order to avoid shift bugs.
   */
  removeItems(indices: number[]): void;
}

// ---------------------------------------------------------------------------
// PendingReplay shape (stored outside React state to avoid extra renders)
// ---------------------------------------------------------------------------

type PendingReplay =
  | { kind: "run"; origin: Origin }
  | { kind: "load-more"; exclusiveStartKey: AttributeMap; origin: "user" };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDynamoItems(
  params: UseDynamoItemsParams,
): UseDynamoItemsResult {
  const { connectionId, tableName, builder, describe } = params;

  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  // Mirror state into a ref so async closures always read the latest values
  // without needing to be listed in dependency arrays.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Separate generation ref that is updated synchronously (before the React
  // batch flushes) so run() can capture the correct generation immediately
  // after dispatching "run-start".
  const generationRef = useRef(1);

  // Stable refs for params so async callbacks don't capture stale values.
  const builderRef = useRef(builder);
  builderRef.current = builder;
  const describeRef = useRef(describe);
  describeRef.current = describe;
  const connectionIdRef = useRef(connectionId);
  connectionIdRef.current = connectionId;
  const tableNameRef = useRef(tableName);
  tableNameRef.current = tableName;

  // The last failed request — replayed by the credentials-refreshed listener.
  const pendingReplayRef = useRef<PendingReplay | null>(null);

  // ---------------------------------------------------------------------------
  // Core page-fetch helper
  // ---------------------------------------------------------------------------

  /**
   * Compiles the current builder state and issues one Scan or Query.
   * Throws an AppError on compile error or AWS error.
   * @param builderOverride When provided, use this builder instead of builderRef.current.
   */
  const executePage = useCallback(
    async (
      exclusiveStartKey: AttributeMap | null,
      origin: Origin,
      pageNumber: number,
      builderOverride?: BuilderState,
    ): Promise<{
      items: AttributeMap[];
      lastEvaluatedKey: AttributeMap | null;
      scannedCount: number;
    }> => {
      const compiled = compile(builderOverride ?? builderRef.current, describeRef.current);

      if (compiled.kind === "error") {
        throw new AppError("Validation", compiled.reason);
      }

      if (compiled.kind === "scan") {
        // compile() puts placeholder "" values in connection_id/table_name/origin;
        // the api wrapper adds the real ones as separate arguments.
        const {
          connection_id: _c,
          table_name: _t,
          origin: _o,
          ...rest
        } = compiled.request;
        const response = await dynamoScan(
          connectionIdRef.current,
          tableNameRef.current,
          { ...rest, exclusive_start_key: exclusiveStartKey, page: pageNumber },
          origin,
        );
        return {
          items: response.items,
          lastEvaluatedKey: response.last_evaluated_key ?? null,
          scannedCount: response.scanned_count,
        };
      }

      // compiled.kind === "query"
      const {
        connection_id: _c,
        table_name: _t,
        origin: _o,
        ...rest
      } = compiled.request;
      const response = await dynamoQuery(
        connectionIdRef.current,
        tableNameRef.current,
        { ...rest, exclusive_start_key: exclusiveStartKey, page: pageNumber },
        origin,
      );
      return {
        items: response.items,
        lastEvaluatedKey: response.last_evaluated_key ?? null,
        scannedCount: response.scanned_count,
      };
    },
    // No deps — all inputs come from refs updated each render.
    [],
  );

  // ---------------------------------------------------------------------------
  // run()
  // ---------------------------------------------------------------------------

  const run = useCallback(
    async (origin: Origin = "user"): Promise<void> => {
      // Bump the generation synchronously so we can capture it before the
      // React batch flushes.
      const generation = generationRef.current + 1;
      generationRef.current = generation;

      dispatch({ type: "run-start" });

      // Record before the await so credentials-refreshed can replay even if
      // the error comes back before the next render.
      pendingReplayRef.current = { kind: "run", origin };

      try {
        const result = await executePage(null, origin, 1);
        // Discard stale responses from a superseded run().
        if (generationRef.current !== generation) return;
        pendingReplayRef.current = null;
        dispatch({
          type: "run-success",
          items: result.items,
          lastEvaluatedKey: result.lastEvaluatedKey,
          scannedCount: result.scannedCount,
        });
      } catch (e) {
        if (generationRef.current !== generation) return;
        const err = asError(e);
        // Keep pendingReplayRef set so credentials-refreshed can replay.
        dispatch({ type: "run-error", error: err });
      }
    },
    [executePage],
  );

  // ---------------------------------------------------------------------------
  // runWithOverride() — per-row Apply path
  // ---------------------------------------------------------------------------

  const runWithOverride = useCallback(
    async (override: BuilderState, origin: Origin = "user"): Promise<void> => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;

      dispatch({ type: "run-start" });

      pendingReplayRef.current = { kind: "run", origin };

      try {
        const result = await executePage(null, origin, 1, override);
        if (generationRef.current !== generation) return;
        pendingReplayRef.current = null;
        dispatch({
          type: "run-success",
          items: result.items,
          lastEvaluatedKey: result.lastEvaluatedKey,
          scannedCount: result.scannedCount,
        });
      } catch (e) {
        if (generationRef.current !== generation) return;
        const err = asError(e);
        dispatch({ type: "run-error", error: err });
      }
    },
    [executePage],
  );

  // ---------------------------------------------------------------------------
  // Internal doLoadMore — shared by loadMore() and triggerAutoLoadMore()
  // ---------------------------------------------------------------------------

  const doLoadMore = useCallback(
    async (origin: "user", resetScrollDisabled: boolean): Promise<void> => {
      const cur = stateRef.current;
      if (cur.status === "loading") return;
      if (cur.lastEvaluatedKey === null) return;

      const exclusiveStartKey = cur.lastEvaluatedKey;
      const nextPage = cur.page + 1;

      // Record before the await.
      pendingReplayRef.current = {
        kind: "load-more",
        exclusiveStartKey,
        origin,
      };

      dispatch({ type: "load-more-start", resetScrollDisabled });

      // Generation is not bumped by load-more (it's not a fresh run), so we
      // use the current generation to detect if a run() was called while we
      // were waiting.
      const generation = generationRef.current;

      try {
        const result = await executePage(exclusiveStartKey, origin, nextPage);
        if (generationRef.current !== generation) return;
        pendingReplayRef.current = null;
        dispatch({
          type: "load-more-success",
          items: result.items,
          lastEvaluatedKey: result.lastEvaluatedKey,
          scannedCount: result.scannedCount,
        });
      } catch (e) {
        if (generationRef.current !== generation) return;
        const err = asError(e);
        dispatch({ type: "load-more-error", error: err });
      }
    },
    [executePage],
  );

  // ---------------------------------------------------------------------------
  // loadMore() — manual, always resets autoScrollDisabled
  // ---------------------------------------------------------------------------

  const loadMore = useCallback(
    async (origin: "user"): Promise<void> => {
      return doLoadMore(origin, /* resetScrollDisabled */ true);
    },
    [doLoadMore],
  );

  // ---------------------------------------------------------------------------
  // triggerAutoLoadMore() — called by virtualised table on viewport entry
  // ---------------------------------------------------------------------------

  const triggerAutoLoadMore = useCallback((): void => {
    const cur = stateRef.current;
    if (cur.autoScrollDisabled) return;
    if (cur.status === "loading") return;
    if (cur.lastEvaluatedKey === null) return;
    void doLoadMore("user", /* resetScrollDisabled */ false);
  }, [doLoadMore]);

  // ---------------------------------------------------------------------------
  // reset()
  // ---------------------------------------------------------------------------

  const reset = useCallback((): void => {
    pendingReplayRef.current = null;
    generationRef.current = 1;
    dispatch({ type: "reset" });
  }, []);

  // ---------------------------------------------------------------------------
  // replaceItem() — task 6.3
  // ---------------------------------------------------------------------------

  const replaceItem = useCallback((index: number, next: AttributeMap): void => {
    dispatch({ type: "replace-item", index, next });
  }, []);

  // ---------------------------------------------------------------------------
  // removeItems() — task 9.4
  // ---------------------------------------------------------------------------

  const removeItems = useCallback((indices: number[]): void => {
    dispatch({ type: "remove-items", indices });
  }, []);

  // ---------------------------------------------------------------------------
  // §7.4  Credentials-refreshed auto-resume
  //
  // CredentialsRefreshedListener bridges Tauri "dynamo:credentials-refreshed"
  // to the window CustomEvent "dynamo:credentials-refreshed:ui" with
  // detail: { id: string }. We subscribe here so we don't open a second
  // raw Tauri listener per hook instance.
  // ---------------------------------------------------------------------------

  // Stable refs for the callbacks so we don't need to re-register the handler
  // when run/loadMore identities change.
  const runRef = useRef(run);
  runRef.current = run;
  const doLoadMoreRef = useRef(doLoadMore);
  doLoadMoreRef.current = doLoadMore;

  useEffect(() => {
    function handleRefreshed(ev: Event) {
      const detail = (ev as CustomEvent<{ id: string }>).detail;
      // Only handle events for our connection.
      if (detail?.id !== connectionIdRef.current) return;

      const replay = pendingReplayRef.current;
      if (!replay) return;

      // Only auto-resume if the failure was credential-expiration.
      const err = stateRef.current.error;
      if (!err || !isExpiredToken(err)) return;

      if (replay.kind === "run") {
        void runRef.current(replay.origin);
      } else {
        // For load-more replays: the reducer's load-more-error path preserves
        // lastEvaluatedKey in state, so calling loadMore() will pick it up
        // naturally. However we call doLoadMore directly with the saved cursor
        // to be safe against edge cases where state was mutated.
        void doLoadMoreRef.current(replay.origin, /* resetScrollDisabled */ true);
      }
    }

    window.addEventListener("dynamo:credentials-refreshed:ui", handleRefreshed);
    return () => {
      window.removeEventListener(
        "dynamo:credentials-refreshed:ui",
        handleRefreshed,
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty: handler reads all state via refs

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const count = useMemo(() => state.items.length, [state.items]);

  return {
    items: state.items,
    lastEvaluatedKey: state.lastEvaluatedKey,
    count,
    scannedCount: state.scannedCount,
    status: state.status,
    error: state.error,
    page: state.page,
    autoScrollDisabled: state.autoScrollDisabled,
    run,
    runWithOverride,
    loadMore,
    triggerAutoLoadMore,
    reset,
    replaceItem,
    removeItems,
  };
}
