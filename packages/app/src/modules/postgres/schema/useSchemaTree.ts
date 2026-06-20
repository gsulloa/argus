import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { AppError } from "@/platform/errors/AppError";
import { isStale } from "@/platform/cache/ttl";
import { isPostgresTimeout } from "../errors";
import { schemaApi } from "./api";
import { subscribeSchemaEvent } from "./events";
import { globalSchemaCache, isSystemSchema } from "./globalSchemaCache";
import type {
  RelationsResult,
  SchemaSummary,
  StructureResult,
  TableExtrasResult,
} from "./types";

/**
 * Hard safety timeout for `postgres_list_table_extras` IPC calls. The backend
 * already has a 10s total query timeout and a 3s acquire timeout, so a healthy
 * call always resolves well under 12s. If 12s passes with no response, treat
 * it as a failure so the per-table loading spinner cannot persist indefinitely
 * (see issue #56).
 */
const TABLE_EXTRAS_SAFETY_TIMEOUT_MS = 12_000;

/**
 * Background fire-and-forget bulk fetch of every column in `schema` for
 * autocomplete pre-population. Skipped for system schemas. Idempotent
 * (no-op if cache already has the bulk or it's in flight).
 */
function triggerColumnsBulk(connectionId: string, schema: string): void {
  if (isSystemSchema(schema)) return;
  if (globalSchemaCache.hasBulkColumns(connectionId, schema)) return;
  if (globalSchemaCache.isBulkInflight(connectionId, schema)) return;
  globalSchemaCache.markBulkInflight(connectionId, schema);
  schemaApi
    .listColumnsBulk(connectionId, schema, "auto")
    .then((result) => {
      const map = new Map(Object.entries(result.columns_by_relation));
      globalSchemaCache.recordColumnsBulk(connectionId, schema, map);
    })
    .catch((e) => {
      console.warn(
        "[argus.schema] listColumnsBulk failed for",
        connectionId,
        "/",
        schema,
        e,
      );
    })
    .finally(() => {
      globalSchemaCache.clearBulkInflight(connectionId, schema);
    });
}

const ACTIVE_EVENT = "postgres:active-changed";

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export type GroupKey = "relations" | "structure";

type GroupState<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "retrying"; previous?: T }
  | { state: "loaded"; payload: T }
  | { state: "error"; error: AppError };

interface GroupCacheEntry {
  relations: GroupState<RelationsResult>;
  structure: GroupState<StructureResult>;
  tableExtras: Map<string, GroupState<TableExtrasResult>>;
}

interface CacheState {
  schemasState: "idle" | "loading" | "loaded" | "error";
  schemas: SchemaSummary[];
  schemasError: AppError | null;
  objects: Map<string, GroupCacheEntry>;
  /** Bump on every invalidate so dependent effects re-run. */
  generation: number;
}

type Action =
  | { type: "schemasLoading" }
  | { type: "seedFromCache"; schemas: SchemaSummary[]; objects: Map<string, GroupCacheEntry> }
  | { type: "schemasLoaded"; schemas: SchemaSummary[] }
  | { type: "schemasFailed"; error: AppError }
  | { type: "relationsLoading"; schema: string }
  | { type: "relationsRetrying"; schema: string }
  | { type: "relationsLoaded"; schema: string; payload: RelationsResult }
  | { type: "relationsFailed"; schema: string; error: AppError }
  | { type: "structureLoading"; schema: string }
  | { type: "structureLoaded"; schema: string; payload: StructureResult }
  | { type: "structureFailed"; schema: string; error: AppError }
  | { type: "tableExtrasLoading"; schema: string; relation: string }
  | { type: "tableExtrasLoaded"; schema: string; relation: string; payload: TableExtrasResult }
  | { type: "tableExtrasFailed"; schema: string; relation: string; error: AppError }
  | { type: "invalidate" }
  | { type: "invalidateSchema"; schema: string }
  | { type: "invalidateGroup"; schema: string; group: GroupKey }
  | { type: "invalidateTableExtras"; schema: string; relation: string };

function emptyEntry(): GroupCacheEntry {
  return {
    relations: { state: "idle" },
    structure: { state: "idle" },
    tableExtras: new Map(),
  };
}

/**
 * Build the reducer's `objects` map by seeding each schema's `relations` slot
 * from any payload already in the process-wide cache. Structure and per-table
 * extras stay lazy (idle) — they are only fetched on user expansion.
 */
function buildSeededObjects(
  connectionId: string,
  schemas: SchemaSummary[],
): Map<string, GroupCacheEntry> {
  const objects = new Map<string, GroupCacheEntry>();
  for (const s of schemas) {
    const relations = globalSchemaCache.getRelations(connectionId, s.name);
    if (relations) {
      objects.set(s.name, {
        relations: { state: "loaded", payload: relations },
        structure: { state: "idle" },
        tableExtras: new Map(),
      });
    }
  }
  return objects;
}

function withEntry(
  state: CacheState,
  schema: string,
  mutator: (e: GroupCacheEntry) => GroupCacheEntry,
): CacheState {
  const next = new Map(state.objects);
  const cur = next.get(schema) ?? emptyEntry();
  next.set(schema, mutator(cur));
  return { ...state, objects: next };
}

function reducer(state: CacheState, action: Action): CacheState {
  switch (action.type) {
    case "schemasLoading":
      return { ...state, schemasState: "loading", schemasError: null };
    case "seedFromCache":
      // Seed local state from the process-wide cache on (re)focus, so an
      // already-loaded connection renders instantly without a refetch. Resets
      // any prior connection's objects map. Does NOT bump `generation` (that
      // would re-trigger the fetch effect).
      return {
        ...state,
        schemasState: "loaded",
        schemas: action.schemas,
        schemasError: null,
        objects: action.objects,
      };
    case "schemasLoaded":
      return {
        ...state,
        schemasState: "loaded",
        schemas: action.schemas,
        schemasError: null,
      };
    case "schemasFailed":
      return { ...state, schemasState: "error", schemasError: action.error };

    case "relationsLoading":
      return withEntry(state, action.schema, (e) => ({
        ...e,
        relations: { state: "loading" },
      }));
    case "relationsRetrying":
      return withEntry(state, action.schema, (e) => {
        const previous =
          e.relations.state === "loaded" ? e.relations.payload : undefined;
        return { ...e, relations: { state: "retrying", previous } };
      });
    case "relationsLoaded":
      return withEntry(state, action.schema, (e) => ({
        ...e,
        relations: { state: "loaded", payload: action.payload },
      }));
    case "relationsFailed":
      return withEntry(state, action.schema, (e) => ({
        ...e,
        relations: { state: "error", error: action.error },
      }));

    case "structureLoading":
      return withEntry(state, action.schema, (e) => ({
        ...e,
        structure: { state: "loading" },
      }));
    case "structureLoaded":
      return withEntry(state, action.schema, (e) => ({
        ...e,
        structure: { state: "loaded", payload: action.payload },
      }));
    case "structureFailed":
      return withEntry(state, action.schema, (e) => ({
        ...e,
        structure: { state: "error", error: action.error },
      }));

    case "tableExtrasLoading":
      return withEntry(state, action.schema, (e) => {
        const next = new Map(e.tableExtras);
        next.set(action.relation, { state: "loading" });
        return { ...e, tableExtras: next };
      });
    case "tableExtrasLoaded":
      return withEntry(state, action.schema, (e) => {
        const next = new Map(e.tableExtras);
        next.set(action.relation, { state: "loaded", payload: action.payload });
        return { ...e, tableExtras: next };
      });
    case "tableExtrasFailed":
      return withEntry(state, action.schema, (e) => {
        const next = new Map(e.tableExtras);
        next.set(action.relation, { state: "error", error: action.error });
        return { ...e, tableExtras: next };
      });

    case "invalidate": {
      // The reducer doesn't know the connectionId — that's owned by the
      // caller. The hook clears `globalSchemaCache` adjacent to dispatching
      // this action (see `invalidate` returned below).
      return {
        schemasState: "idle",
        schemas: [],
        schemasError: null,
        objects: new Map(),
        generation: state.generation + 1,
      };
    }
    case "invalidateSchema": {
      const next = new Map(state.objects);
      next.delete(action.schema);
      return { ...state, objects: next };
    }
    case "invalidateGroup":
      return withEntry(state, action.schema, (e) => {
        if (action.group === "relations") {
          return { ...e, relations: { state: "idle" } };
        }
        return { ...e, structure: { state: "idle" } };
      });
    case "invalidateTableExtras":
      return withEntry(state, action.schema, (e) => {
        const next = new Map(e.tableExtras);
        next.delete(action.relation);
        return { ...e, tableExtras: next };
      });

    default:
      return state;
  }
}

const initialState: CacheState = {
  schemasState: "idle",
  schemas: [],
  schemasError: null,
  objects: new Map(),
  generation: 0,
};

export type PublicGroupState = "idle" | "loading" | "retrying" | "loaded" | "error";

export interface UseSchemaTreeResult {
  schemas: SchemaSummary[];
  schemasLoading: boolean;
  schemasError: AppError | null;

  /**
   * Eager: returns cached `RelationsResult` or `null`. If `null` and the slot
   * is `idle`, queues a microtask that fires the load. Subsequent reads while
   * the request is in flight do not re-trigger.
   */
  getRelations(schema: string): RelationsResult | null;
  getRelationsState(schema: string): PublicGroupState;
  getRelationsError(schema: string): AppError | null;
  /** Re-run `relations` fetch, using the auto-retry-on-57014 path. */
  retryRelations(schema: string): void;

  /**
   * Lazy: returns cached `StructureResult` or `null`. Does NOT auto-trigger.
   * Consumers must call `loadStructure(schema)` (typically from the `Structure`
   * group's `onExpand` handler).
   */
  getStructure(schema: string): StructureResult | null;
  getStructureState(schema: string): PublicGroupState;
  getStructureError(schema: string): AppError | null;
  loadStructure(schema: string): void;

  /**
   * Lazy: returns cached `TableExtrasResult` for one relation, or `null`. Does
   * NOT auto-trigger; consumers must call `loadTableExtras` (typically from a
   * table node's `onExpand` handler).
   */
  getTableExtras(schema: string, relation: string): TableExtrasResult | null;
  getTableExtrasState(schema: string, relation: string): PublicGroupState;
  getTableExtrasError(schema: string, relation: string): AppError | null;
  loadTableExtras(schema: string, relation: string): void;

  /** Drop the entire cache and re-fetch on next read. */
  invalidate(): void;
  /** Drop one schema's cached entry (forces a re-fetch on next read). */
  invalidateSchema(schema: string): void;
  /** Drop a single group's cache slot for a schema. */
  invalidateGroup(schema: string, group: GroupKey): void;
  /** Drop a single table's extras cache slot. */
  invalidateTableExtras(schema: string, relation: string): void;
}

export function useSchemaTree(connectionId: string | null): UseSchemaTreeResult {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * Which connection the current reducer state was seeded/loaded for. Because
   * `<SchemaTree>` is not keyed by connectionId, a focus switch updates the
   * `connectionId` prop on the same hook instance rather than remounting; this
   * ref lets us tell a same-connection re-run (skip) from a focus switch
   * (re-seed from cache or fetch).
   */
  const loadedForRef = useRef<string | null>(null);

  /**
   * Background-refreshes every already-loaded `relations` slot via the
   * retrying path, which keeps the previous payload visible (no per-schema
   * loading flash). Held in a ref so the schemas effect can call it without
   * taking `runFetchRelations` as a dependency. Assigned below, after
   * `runFetchRelations` is defined.
   */
  const backgroundRefreshRelationsRef = useRef<() => void>(() => {});

  // Schemas: seed from the process-wide cache on (re)focus, then fetch only
  // when there is no cache or the cached entry is stale (TTL).
  // NOTE: deps are intentionally only [connectionId, generation]. Including
  // `state.schemasState` would cause the effect to re-run on the
  // `schemasLoading` dispatch, cancel the in-flight request, and leave state
  // stuck on "loading".
  useEffect(() => {
    if (!connectionId) {
      dispatch({ type: "invalidate" });
      loadedForRef.current = null;
      return;
    }
    if (!isTauriRuntime()) return;

    const sameConn = loadedForRef.current === connectionId;
    const settled =
      stateRef.current.schemasState === "loaded" ||
      stateRef.current.schemasState === "error";
    const cachedSchemas = globalSchemaCache.getSchemas(connectionId);
    const hasCache = cachedSchemas.length > 0;
    const stale = isStale(globalSchemaCache.getSchemasFetchedAt(connectionId));

    // Same connection, already settled, and fresh → nothing to do (guards
    // StrictMode double-invoke and incidental re-runs).
    if (sameConn && settled && !stale) return;

    let cancelled = false;

    // Seed instantly from cache on a focus switch so the tree never blanks.
    if (!sameConn && hasCache) {
      console.debug("[argus.schema] seeding from cache for", connectionId);
      dispatch({
        type: "seedFromCache",
        schemas: cachedSchemas,
        objects: buildSeededObjects(connectionId, cachedSchemas),
      });
      loadedForRef.current = connectionId;
      if (!stale) return; // fresh cache → no refetch
      // stale → fall through to a background refresh (no loading flash)
    }

    // Show the loading state only when we have nothing to render yet.
    const showLoading = !hasCache && !(sameConn && settled);
    if (showLoading) dispatch({ type: "schemasLoading" });

    console.debug(
      "[argus.schema] listSchemas → fetching for",
      connectionId,
      stale && hasCache ? "(stale background refresh)" : "",
    );
    schemaApi
      .listSchemas(connectionId)
      .then((schemas) => {
        if (cancelled) {
          console.debug("[argus.schema] listSchemas resolved but cancelled", { connectionId });
          return;
        }
        console.debug(
          "[argus.schema] listSchemas ←",
          schemas.length,
          "schemas for",
          connectionId,
        );
        globalSchemaCache.recordSchemas(connectionId, schemas);
        dispatch({ type: "schemasLoaded", schemas });
        loadedForRef.current = connectionId;
        // On a stale refresh, also refresh the relation slots we just seeded
        // as loaded, so the tree reflects current relations without a flash.
        if (stale && hasCache) backgroundRefreshRelationsRef.current();
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A stale background refresh that fails keeps the cached data visible.
        if (stale && hasCache) {
          console.warn(
            "[argus.schema] background listSchemas refresh failed; keeping cache for",
            connectionId,
            e,
          );
          return;
        }
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        console.error("[argus.schema] listSchemas failed for", connectionId, err);
        dispatch({ type: "schemasFailed", error: err });
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, state.generation]);

  // Drop the cache when the connection becomes inactive. Clear the
  // process-wide cache too so a later reconnect cannot seed stale data.
  useEffect(() => {
    if (!connectionId || !isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<unknown>(ACTIVE_EVENT, () => {
      globalSchemaCache.invalidate(connectionId);
      dispatch({ type: "invalidate" });
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [connectionId]);

  // Listen for palette-driven invalidations targeting this connection.
  useEffect(() => {
    if (!connectionId) return;
    return subscribeSchemaEvent((e) => {
      if (e.type === "invalidate" && e.connectionId === connectionId) {
        dispatch({ type: "invalidate" });
      }
    });
  }, [connectionId]);

  /**
   * Eager `relations` fetch with one auto-retry on SQLSTATE 57014. Used by
   * `getRelations` (lazy first-time fetch) and `retryRelations` (manual retry).
   */
  const runFetchRelations = useCallback(
    async (schema: string, isRetry: boolean) => {
      if (!connectionId) return;
      console.debug(
        "[argus.schema] listRelations → fetching",
        connectionId,
        "/",
        schema,
        isRetry ? "(retry)" : "",
      );
      dispatch(
        isRetry
          ? { type: "relationsRetrying", schema }
          : { type: "relationsLoading", schema },
      );
      try {
        const payload = await schemaApi.listRelations(connectionId, schema);
        console.debug(
          "[argus.schema] listRelations ←",
          connectionId,
          "/",
          schema,
          {
            tables: payload.tables.length,
            views: payload.views.length,
            mat_views: payload.materialized_views.length,
          },
        );
        globalSchemaCache.recordRelations(connectionId, schema, payload);
        dispatch({ type: "relationsLoaded", schema, payload });
        // Fire-and-forget bulk fetch of every column in this schema —
        // pre-populates the autocomplete cache for the SQL editor.
        triggerColumnsBulk(connectionId, schema);
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        if (!isRetry && isPostgresTimeout(err)) {
          console.warn(
            "[argus.schema] listRelations timed out — auto-retrying once for",
            connectionId,
            "/",
            schema,
          );
          await runFetchRelations(schema, true);
          return;
        }
        console.error(
          "[argus.schema] listRelations failed for",
          connectionId,
          "/",
          schema,
          err,
        );
        dispatch({ type: "relationsFailed", schema, error: err });
      }
    },
    [connectionId],
  );

  // Keep the background relations-refresh closure current. Re-runs each render
  // so it always closes over the latest `runFetchRelations`.
  backgroundRefreshRelationsRef.current = () => {
    for (const [schema, entry] of stateRef.current.objects) {
      if (entry.relations.state === "loaded") {
        void runFetchRelations(schema, true);
      }
    }
  };

  const triggerRelationsFetch = useCallback(
    (schema: string) => {
      if (!connectionId) return;
      const cur = stateRef.current.objects.get(schema)?.relations;
      if (
        cur &&
        (cur.state === "loading" || cur.state === "retrying" || cur.state === "loaded")
      ) {
        return;
      }
      void runFetchRelations(schema, false);
    },
    [connectionId, runFetchRelations],
  );

  const retryRelations = useCallback(
    (schema: string) => {
      if (!connectionId) return;
      void runFetchRelations(schema, false);
    },
    [connectionId, runFetchRelations],
  );

  /**
   * Lazy `structure` fetch. No auto-retry — the user explicitly expanded the
   * group, so any error gets a manual retry button.
   */
  const runFetchStructure = useCallback(
    async (schema: string) => {
      if (!connectionId) return;
      console.debug(
        "[argus.schema] listStructure → fetching",
        connectionId,
        "/",
        schema,
      );
      dispatch({ type: "structureLoading", schema });
      try {
        const payload = await schemaApi.listStructure(connectionId, schema);
        console.debug(
          "[argus.schema] listStructure ←",
          connectionId,
          "/",
          schema,
          {
            functions: payload.functions?.length ?? -1,
            types: payload.types?.length ?? -1,
            extensions: payload.extensions?.length ?? -1,
            failures: payload.failures.length,
          },
        );
        dispatch({ type: "structureLoaded", schema, payload });
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        console.error(
          "[argus.schema] listStructure failed for",
          connectionId,
          "/",
          schema,
          err,
        );
        dispatch({ type: "structureFailed", schema, error: err });
      }
    },
    [connectionId],
  );

  const loadStructure = useCallback(
    (schema: string) => {
      if (!connectionId) return;
      const cur = stateRef.current.objects.get(schema)?.structure;
      // Idempotent under multiple expand events: skip if already loading.
      if (cur && cur.state === "loading") return;
      void runFetchStructure(schema);
    },
    [connectionId, runFetchStructure],
  );

  /**
   * Tracks (schema, relation) pairs whose listTableExtras call has already been
   * "safety-tripped" — i.e. the 12s safety timer fired and dispatched a failure.
   * Late-arriving resolve/reject for those calls becomes a no-op so the failed
   * state isn't clobbered by a stale success.
   */
  const safetyTrippedRef = useRef<Set<string>>(new Set());

  /**
   * Lazy per-table extras fetch. No auto-retry.
   */
  const runFetchTableExtras = useCallback(
    async (schema: string, relation: string) => {
      if (!connectionId) return;
      const key = `${schema} ${relation}`;
      safetyTrippedRef.current.delete(key);

      console.debug(
        "[argus.schema] listTableExtras → fetching",
        connectionId,
        "/",
        schema,
        "/",
        relation,
      );
      dispatch({ type: "tableExtrasLoading", schema, relation });

      const SAFETY_TIMEOUT_SENTINEL = Symbol("safety-timeout");
      let safetyTimer: ReturnType<typeof setTimeout> | null = null;
      const safetyTimeout = new Promise<typeof SAFETY_TIMEOUT_SENTINEL>((resolve) => {
        safetyTimer = setTimeout(() => resolve(SAFETY_TIMEOUT_SENTINEL), TABLE_EXTRAS_SAFETY_TIMEOUT_MS);
      });

      try {
        const result = await Promise.race([
          schemaApi
            .listTableExtras(connectionId, schema, relation)
            .then((payload) => ({ kind: "ok" as const, payload }))
            .catch((e: unknown) => ({ kind: "err" as const, error: e })),
          safetyTimeout,
        ]);

        if (result === SAFETY_TIMEOUT_SENTINEL) {
          safetyTrippedRef.current.add(key);
          const err = new AppError(
            "Internal",
            `Loading table details timed out (${TABLE_EXTRAS_SAFETY_TIMEOUT_MS / 1000}s).`,
          );
          console.error(
            "[argus.schema] listTableExtras safety timeout for",
            connectionId,
            "/",
            schema,
            "/",
            relation,
          );
          dispatch({ type: "tableExtrasFailed", schema, relation, error: err });
          return;
        }

        // Late branch — IPC actually returned. Treat as a no-op if the safety
        // timer already fired for this (schema, relation).
        if (safetyTrippedRef.current.has(key)) {
          console.debug(
            "[argus.schema] listTableExtras late response ignored (safety-tripped)",
            connectionId,
            "/",
            schema,
            "/",
            relation,
          );
          return;
        }

        if (result.kind === "ok") {
          const payload = result.payload;
          console.debug(
            "[argus.schema] listTableExtras ←",
            connectionId,
            "/",
            schema,
            "/",
            relation,
            {
              indexes: payload.indexes?.length ?? -1,
              triggers: payload.triggers?.length ?? -1,
              failures: payload.failures.length,
            },
          );
          dispatch({ type: "tableExtrasLoaded", schema, relation, payload });
        } else {
          const err =
            result.error instanceof AppError
              ? result.error
              : new AppError("Internal", String(result.error));
          console.error(
            "[argus.schema] listTableExtras failed for",
            connectionId,
            "/",
            schema,
            "/",
            relation,
            err,
          );
          dispatch({ type: "tableExtrasFailed", schema, relation, error: err });
        }
      } finally {
        if (safetyTimer) clearTimeout(safetyTimer);
      }
    },
    [connectionId],
  );

  const loadTableExtras = useCallback(
    (schema: string, relation: string) => {
      if (!connectionId) return;
      const cur = stateRef.current.objects.get(schema)?.tableExtras.get(relation);
      if (cur && cur.state === "loading") return;
      void runFetchTableExtras(schema, relation);
    },
    [connectionId, runFetchTableExtras],
  );

  const getRelations = useCallback(
    (schema: string): RelationsResult | null => {
      const cur = state.objects.get(schema)?.relations;
      if (!cur || cur.state === "idle") {
        // Trigger fetch in a microtask to avoid setState-in-render.
        queueMicrotask(() => triggerRelationsFetch(schema));
        return null;
      }
      if (cur.state === "loaded") return cur.payload;
      if (cur.state === "retrying") return cur.previous ?? null;
      return null;
    },
    [state.objects, triggerRelationsFetch],
  );

  const getRelationsState = useCallback(
    (schema: string): PublicGroupState => {
      return state.objects.get(schema)?.relations.state ?? "idle";
    },
    [state.objects],
  );

  const getRelationsError = useCallback(
    (schema: string): AppError | null => {
      const cur = state.objects.get(schema)?.relations;
      return cur && cur.state === "error" ? cur.error : null;
    },
    [state.objects],
  );

  const getStructure = useCallback(
    (schema: string): StructureResult | null => {
      const cur = state.objects.get(schema)?.structure;
      return cur && cur.state === "loaded" ? cur.payload : null;
    },
    [state.objects],
  );

  const getStructureState = useCallback(
    (schema: string): PublicGroupState => {
      return state.objects.get(schema)?.structure.state ?? "idle";
    },
    [state.objects],
  );

  const getStructureError = useCallback(
    (schema: string): AppError | null => {
      const cur = state.objects.get(schema)?.structure;
      return cur && cur.state === "error" ? cur.error : null;
    },
    [state.objects],
  );

  const getTableExtras = useCallback(
    (schema: string, relation: string): TableExtrasResult | null => {
      const cur = state.objects.get(schema)?.tableExtras.get(relation);
      return cur && cur.state === "loaded" ? cur.payload : null;
    },
    [state.objects],
  );

  const getTableExtrasState = useCallback(
    (schema: string, relation: string): PublicGroupState => {
      return state.objects.get(schema)?.tableExtras.get(relation)?.state ?? "idle";
    },
    [state.objects],
  );

  const getTableExtrasError = useCallback(
    (schema: string, relation: string): AppError | null => {
      const cur = state.objects.get(schema)?.tableExtras.get(relation);
      return cur && cur.state === "error" ? cur.error : null;
    },
    [state.objects],
  );

  const invalidate = useCallback(() => {
    if (connectionId) globalSchemaCache.invalidate(connectionId);
    dispatch({ type: "invalidate" });
  }, [connectionId]);

  const invalidateSchema = useCallback((schema: string) => {
    dispatch({ type: "invalidateSchema", schema });
  }, []);

  const invalidateGroup = useCallback((schema: string, group: GroupKey) => {
    dispatch({ type: "invalidateGroup", schema, group });
  }, []);

  const invalidateTableExtras = useCallback((schema: string, relation: string) => {
    dispatch({ type: "invalidateTableExtras", schema, relation });
  }, []);

  return useMemo<UseSchemaTreeResult>(
    () => ({
      schemas: state.schemas,
      schemasLoading: state.schemasState === "loading",
      schemasError: state.schemasError,
      getRelations,
      getRelationsState,
      getRelationsError,
      retryRelations,
      getStructure,
      getStructureState,
      getStructureError,
      loadStructure,
      getTableExtras,
      getTableExtrasState,
      getTableExtrasError,
      loadTableExtras,
      invalidate,
      invalidateSchema,
      invalidateGroup,
      invalidateTableExtras,
    }),
    [
      state.schemas,
      state.schemasState,
      state.schemasError,
      getRelations,
      getRelationsState,
      getRelationsError,
      retryRelations,
      getStructure,
      getStructureState,
      getStructureError,
      loadStructure,
      getTableExtras,
      getTableExtrasState,
      getTableExtrasError,
      loadTableExtras,
      invalidate,
      invalidateSchema,
      invalidateGroup,
      invalidateTableExtras,
    ],
  );
}
