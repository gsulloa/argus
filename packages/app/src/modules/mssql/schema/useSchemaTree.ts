import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { AppError } from "@/platform/errors/AppError";
import { isStale } from "@/platform/cache/ttl";
import { schemaApi } from "./api";
import { subscribeMssqlSchemaEvent } from "./events";
import { mssqlSchemaCache } from "./globalSchemaCache";
import type {
  RelationsResult,
  SchemaInfo,
  StructureResult,
  TableExtrasResult,
} from "../types";

const ACTIVE_EVENT = "mssql:active-changed";

/**
 * Check for MSSQL cancellation: code: None, message: "query cancelled".
 * The backend maps TDS Attention / Cancelled to AppError::Mssql { code: None, message: "query cancelled" }.
 */
function isMssqlCancelError(err: AppError): boolean {
  return (
    err.message?.toLowerCase().includes("query cancelled") ||
    err.message?.toLowerCase().includes("query_cancelled") ||
    false
  );
}

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
  schemas: SchemaInfo[];
  schemasError: AppError | null;
  objects: Map<string, GroupCacheEntry>;
  generation: number;
}

type Action =
  | { type: "schemasLoading" }
  | { type: "seedFromCache"; schemas: SchemaInfo[]; objects: Map<string, GroupCacheEntry> }
  | { type: "schemasLoaded"; schemas: SchemaInfo[] }
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
 * extras stay lazy (idle) — only fetched on user expansion.
 */
function buildSeededObjects(
  connectionId: string,
  schemas: SchemaInfo[],
): Map<string, GroupCacheEntry> {
  const objects = new Map<string, GroupCacheEntry>();
  for (const s of schemas) {
    const relations = mssqlSchemaCache.getRelations(connectionId, s.name);
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
      // Seed local state from the process-wide cache on (re)focus so an
      // already-loaded connection renders instantly without a refetch.
      // Resets any prior connection's objects map; does NOT bump generation.
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

    case "invalidate":
      return {
        schemasState: "idle",
        schemas: [],
        schemasError: null,
        objects: new Map(),
        generation: state.generation + 1,
      };
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
  schemas: SchemaInfo[];
  schemasLoading: boolean;
  schemasError: AppError | null;

  getRelations(schema: string): RelationsResult | null;
  getRelationsState(schema: string): PublicGroupState;
  getRelationsError(schema: string): AppError | null;
  /** Re-run `relations` fetch, using the auto-retry-on-cancel path. */
  retryRelations(schema: string): void;

  getStructure(schema: string): StructureResult | null;
  getStructureState(schema: string): PublicGroupState;
  getStructureError(schema: string): AppError | null;
  loadStructure(schema: string): void;

  getTableExtras(schema: string, relation: string): TableExtrasResult | null;
  getTableExtrasState(schema: string, relation: string): PublicGroupState;
  getTableExtrasError(schema: string, relation: string): AppError | null;
  loadTableExtras(schema: string, relation: string): void;

  /** Drop the entire cache and re-fetch on next read. */
  invalidate(): void;
  invalidateSchema(schema: string): void;
  invalidateGroup(schema: string, group: GroupKey): void;
  invalidateTableExtras(schema: string, relation: string): void;
}

export function useSchemaTree(connectionId: string | null): UseSchemaTreeResult {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * Which connection the current reducer state was seeded/loaded for. The tree
   * is not keyed by connectionId, so a focus switch updates the prop on the
   * same hook instance rather than remounting; this ref distinguishes a
   * same-connection re-run (skip) from a focus switch (re-seed or fetch).
   */
  const loadedForRef = useRef<string | null>(null);

  /**
   * Background-refreshes every already-loaded `relations` slot via the
   * retrying path (keeps the previous payload visible — no per-schema flash).
   * Held in a ref so the schemas effect can call it without depending on
   * `runFetchRelations`; assigned below, after that callback is defined.
   */
  const backgroundRefreshRelationsRef = useRef<() => void>(() => {});

  // Schemas: seed from the process-wide cache on (re)focus, then fetch only
  // when there is no cache or the cached entry is stale (TTL).
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
    const cachedSchemas = mssqlSchemaCache.getSchemas(connectionId);
    const hasCache = cachedSchemas.length > 0;
    const stale = isStale(mssqlSchemaCache.getSchemasFetchedAt(connectionId));

    // Same connection, settled, and fresh → nothing to do.
    if (sameConn && settled && !stale) return;

    let cancelled = false;

    // Seed instantly from cache on a focus switch so the tree never blanks.
    if (!sameConn && hasCache) {
      dispatch({
        type: "seedFromCache",
        schemas: cachedSchemas,
        objects: buildSeededObjects(connectionId, cachedSchemas),
      });
      loadedForRef.current = connectionId;
      if (!stale) return; // fresh cache → no refetch
      // stale → fall through to a background refresh (no loading flash)
    }

    const showLoading = !hasCache && !(sameConn && settled);
    if (showLoading) dispatch({ type: "schemasLoading" });

    schemaApi
      .listSchemas(connectionId)
      .then((schemas) => {
        if (cancelled) return;
        mssqlSchemaCache.recordSchemas(connectionId, schemas);
        dispatch({ type: "schemasLoaded", schemas });
        loadedForRef.current = connectionId;
        if (stale && hasCache) backgroundRefreshRelationsRef.current();
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A stale background refresh that fails keeps the cached data visible.
        if (stale && hasCache) {
          console.warn(
            "[argus.mssql.schema] background listSchemas refresh failed; keeping cache for",
            connectionId,
            e,
          );
          return;
        }
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        console.error("[argus.mssql.schema] listSchemas failed for", connectionId, err);
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
      mssqlSchemaCache.invalidate(connectionId);
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

  // Listen for palette-driven invalidations.
  useEffect(() => {
    if (!connectionId) return;
    return subscribeMssqlSchemaEvent((e) => {
      if (e.type === "invalidate" && e.connectionId === connectionId) {
        if (connectionId) mssqlSchemaCache.invalidate(connectionId);
        dispatch({ type: "invalidate" });
      }
    });
  }, [connectionId]);

  /**
   * Eager `relations` fetch with one auto-retry on MSSQL cancellation.
   * - First call on idle: runs normally.
   * - If first call returns cancel error: auto-retries once (retrying state).
   * - If retry also fails: surfaces error state with manual retry.
   */
  const runFetchRelations = useCallback(
    async (schema: string, isRetry: boolean) => {
      if (!connectionId) return;
      dispatch(
        isRetry
          ? { type: "relationsRetrying", schema }
          : { type: "relationsLoading", schema },
      );
      try {
        const payload = await schemaApi.listRelations(connectionId, schema);
        mssqlSchemaCache.recordRelations(connectionId, schema, payload);
        dispatch({ type: "relationsLoaded", schema, payload });
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        // Auto-retry on cancellation, exactly once.
        if (!isRetry && isMssqlCancelError(err)) {
          console.warn(
            "[argus.mssql.schema] listRelations cancelled — auto-retrying once for",
            connectionId,
            "/",
            schema,
          );
          await runFetchRelations(schema, true);
          return;
        }
        console.error(
          "[argus.mssql.schema] listRelations failed for",
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
   * Lazy `structure` fetch — NO auto-retry. Any error surfaces manual retry.
   */
  const runFetchStructure = useCallback(
    async (schema: string) => {
      if (!connectionId) return;
      dispatch({ type: "structureLoading", schema });
      try {
        const payload = await schemaApi.listStructure(connectionId, schema);
        mssqlSchemaCache.recordStructure(connectionId, schema, payload);
        dispatch({ type: "structureLoaded", schema, payload });
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        console.error(
          "[argus.mssql.schema] listStructure failed for",
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
      if (cur && cur.state === "loading") return;
      void runFetchStructure(schema);
    },
    [connectionId, runFetchStructure],
  );

  /**
   * Lazy per-table extras fetch — NO auto-retry.
   */
  const runFetchTableExtras = useCallback(
    async (schema: string, relation: string) => {
      if (!connectionId) return;
      dispatch({ type: "tableExtrasLoading", schema, relation });
      try {
        const payload = await schemaApi.listTableExtras(connectionId, schema, relation);
        mssqlSchemaCache.recordTableExtras(connectionId, schema, relation, payload);
        dispatch({ type: "tableExtrasLoaded", schema, relation, payload });
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        console.error(
          "[argus.mssql.schema] listTableExtras failed for",
          connectionId,
          "/",
          schema,
          "/",
          relation,
          err,
        );
        dispatch({ type: "tableExtrasFailed", schema, relation, error: err });
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
    if (connectionId) mssqlSchemaCache.invalidate(connectionId);
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
