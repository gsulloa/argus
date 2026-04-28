import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { AppError } from "@/platform/errors/AppError";
import { schemaApi } from "./api";
import { subscribeSchemaEvent } from "./events";
import type { SchemaObjects, SchemaSummary } from "./types";

const ACTIVE_EVENT = "postgres:active-changed";

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

type ObjectState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "retrying"; previous?: SchemaObjects }
  | { state: "loaded"; payload: SchemaObjects }
  | { state: "error"; error: AppError };

/** SQLSTATE for `query_canceled` — what the backend returns on its own 15s timeout. */
const RETRYABLE_TIMEOUT_CODE = "57014";

function isTimeout(err: AppError): boolean {
  return err.kind === "Postgres" && err.postgres?.code === RETRYABLE_TIMEOUT_CODE;
}

interface CacheState {
  schemasState: "idle" | "loading" | "loaded" | "error";
  schemas: SchemaSummary[];
  schemasError: AppError | null;
  objects: Map<string, ObjectState>;
  /** Bump on every invalidate so dependent effects re-run. */
  generation: number;
}

type Action =
  | { type: "schemasLoading" }
  | { type: "schemasLoaded"; schemas: SchemaSummary[] }
  | { type: "schemasFailed"; error: AppError }
  | { type: "objectsLoading"; schema: string }
  | { type: "objectsRetrying"; schema: string }
  | { type: "objectsLoaded"; schema: string; payload: SchemaObjects }
  | { type: "objectsFailed"; schema: string; error: AppError }
  | { type: "invalidate" }
  | { type: "invalidateSchema"; schema: string };

function reducer(state: CacheState, action: Action): CacheState {
  switch (action.type) {
    case "schemasLoading":
      return { ...state, schemasState: "loading", schemasError: null };
    case "schemasLoaded":
      return {
        ...state,
        schemasState: "loaded",
        schemas: action.schemas,
        schemasError: null,
      };
    case "schemasFailed":
      return { ...state, schemasState: "error", schemasError: action.error };
    case "objectsLoading": {
      const next = new Map(state.objects);
      next.set(action.schema, { state: "loading" });
      return { ...state, objects: next };
    }
    case "objectsRetrying": {
      const next = new Map(state.objects);
      const cur = state.objects.get(action.schema);
      // If we already have a loaded payload, keep it as `previous` so the UI
      // can keep showing stale counts during the retry instead of going blank.
      const previous = cur && cur.state === "loaded" ? cur.payload : undefined;
      next.set(action.schema, { state: "retrying", previous });
      return { ...state, objects: next };
    }
    case "objectsLoaded": {
      const next = new Map(state.objects);
      next.set(action.schema, { state: "loaded", payload: action.payload });
      return { ...state, objects: next };
    }
    case "objectsFailed": {
      const next = new Map(state.objects);
      next.set(action.schema, { state: "error", error: action.error });
      return { ...state, objects: next };
    }
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

export interface UseSchemaTreeResult {
  schemas: SchemaSummary[];
  schemasLoading: boolean;
  schemasError: AppError | null;
  /**
   * Get the cached object payload for a schema. If not yet loaded, returns
   * `null` and triggers a background fetch (idempotent during the loading
   * window). When in `retrying` state, returns the previously loaded payload
   * if any (so the UI keeps showing stale-but-known data during the retry).
   */
  getObjects(schema: string): SchemaObjects | null;
  /** State for a schema's object payload (idle / loading / retrying / loaded / error). */
  getObjectsState(schema: string): ObjectState["state"];
  /** Last error for a schema, or `null`. */
  getObjectsError(schema: string): AppError | null;
  /** Drop the entire cache and re-fetch on next read. */
  invalidate(): void;
  /** Drop one schema's cached objects (forces a re-fetch on next read). */
  invalidateSchema(schema: string): void;
  /** Re-run the fetch for a schema; resets any error/retrying state first. */
  retrySchema(schema: string): void;
}

export function useSchemaTree(connectionId: string | null): UseSchemaTreeResult {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Schemas: kick off a fetch when (re)connected or after invalidate.
  // NOTE: deps are intentionally only [connectionId, generation]. Including
  // `state.schemasState` would cause the effect to re-run on the
  // `schemasLoading` dispatch, cancel the in-flight request, and leave state
  // stuck on "loading". The `idle` guard inside the body prevents duplicate
  // fetches when this effect happens to re-mount.
  useEffect(() => {
    if (!connectionId) {
      dispatch({ type: "invalidate" });
      return;
    }
    if (!isTauriRuntime()) return;
    if (stateRef.current.schemasState !== "idle") {
      console.debug(
        "[argus.schema] listSchemas skipped — current state:",
        stateRef.current.schemasState,
        "for connection",
        connectionId,
      );
      return;
    }
    let cancelled = false;
    console.debug("[argus.schema] listSchemas → fetching for", connectionId);
    dispatch({ type: "schemasLoading" });
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
        dispatch({ type: "schemasLoaded", schemas });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        console.error("[argus.schema] listSchemas failed for", connectionId, err);
        dispatch({ type: "schemasFailed", error: err });
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, state.generation]);

  // Drop the cache when the connection becomes inactive.
  useEffect(() => {
    if (!connectionId || !isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<unknown>(ACTIVE_EVENT, () => {
      // We don't get the active-id-set here; just invalidate. The next read
      // will hit `listSchemas` again, which returns NotFound if the pool is
      // gone — that's fine; the parent stops rendering the tree on disconnect.
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
   * Run `listObjects` for a schema with one auto-retry on SQLSTATE 57014.
   * Used both by `getObjects` (lazy first-time fetch) and `retrySchema`
   * (manual user-initiated retry).
   *
   * When `isRetry` is true the dispatched loading state is `objectsRetrying`
   * (so the UI keeps showing the previous payload's counts as stale data).
   * Otherwise it's `objectsLoading`.
   */
  const runFetch = useCallback(
    async (schema: string, isRetry: boolean) => {
      if (!connectionId) return;
      console.debug(
        "[argus.schema] listObjects → fetching",
        connectionId,
        "/",
        schema,
        isRetry ? "(retry)" : "",
      );
      dispatch(
        isRetry
          ? { type: "objectsRetrying", schema }
          : { type: "objectsLoading", schema },
      );
      try {
        const payload = await schemaApi.listObjects(connectionId, schema);
        console.debug(
          "[argus.schema] listObjects ←",
          connectionId,
          "/",
          schema,
          {
            tables: payload.tables.length,
            views: payload.views.length,
            mat_views: payload.materialized_views.length,
            functions: payload.functions.length,
            types: payload.types.length,
            extensions: payload.extensions.length,
            indexes: payload.indexes.length,
            triggers: payload.triggers.length,
          },
        );
        dispatch({ type: "objectsLoaded", schema, payload });
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError("Internal", String(e));
        // Auto-retry exactly once on backend timeout (SQLSTATE 57014).
        // Any other error, or a second timeout, surfaces as `error`.
        if (!isRetry && isTimeout(err)) {
          console.warn(
            "[argus.schema] listObjects timed out — auto-retrying once for",
            connectionId,
            "/",
            schema,
          );
          await runFetch(schema, true);
          return;
        }
        console.error(
          "[argus.schema] listObjects failed for",
          connectionId,
          "/",
          schema,
          err,
        );
        dispatch({ type: "objectsFailed", schema, error: err });
      }
    },
    [connectionId],
  );

  const fetchObjects = useCallback(
    (schema: string) => {
      if (!connectionId) return;
      const cur = stateRef.current.objects.get(schema);
      if (cur && (cur.state === "loading" || cur.state === "retrying" || cur.state === "loaded"))
        return;
      void runFetch(schema, false);
    },
    [connectionId, runFetch],
  );

  const retrySchema = useCallback(
    (schema: string) => {
      if (!connectionId) return;
      void runFetch(schema, false);
    },
    [connectionId, runFetch],
  );

  const getObjects = useCallback(
    (schema: string): SchemaObjects | null => {
      const cur = state.objects.get(schema);
      if (!cur || cur.state === "idle") {
        // Trigger fetch in a microtask to avoid setState-in-render.
        queueMicrotask(() => fetchObjects(schema));
        return null;
      }
      if (cur.state === "loaded") return cur.payload;
      // While retrying, surface the prior payload (if any) so the tree keeps
      // showing the previous content rather than going blank.
      if (cur.state === "retrying") return cur.previous ?? null;
      return null;
    },
    [state.objects, fetchObjects],
  );

  const getObjectsState = useCallback(
    (schema: string) => {
      const cur = state.objects.get(schema);
      return cur?.state ?? "idle";
    },
    [state.objects],
  );

  const getObjectsError = useCallback(
    (schema: string): AppError | null => {
      const cur = state.objects.get(schema);
      return cur && cur.state === "error" ? cur.error : null;
    },
    [state.objects],
  );

  const invalidate = useCallback(() => {
    dispatch({ type: "invalidate" });
  }, []);

  const invalidateSchema = useCallback((schema: string) => {
    dispatch({ type: "invalidateSchema", schema });
  }, []);

  return useMemo<UseSchemaTreeResult>(
    () => ({
      schemas: state.schemas,
      schemasLoading: state.schemasState === "loading",
      schemasError: state.schemasError,
      getObjects,
      getObjectsState,
      getObjectsError,
      invalidate,
      invalidateSchema,
      retrySchema,
    }),
    [
      state.schemas,
      state.schemasState,
      state.schemasError,
      getObjects,
      getObjectsState,
      getObjectsError,
      invalidate,
      invalidateSchema,
      retrySchema,
    ],
  );
}
