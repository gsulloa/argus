/**
 * §22 — MS SQL Server bulk columns cache.
 *
 * Process-wide in-memory cache keyed by `(connectionId, schema)`.
 * Populated on first SQL editor open (fire-and-forget pre-warm) and
 * refreshed by the explicit "Refresh columns" affordance.
 *
 * Does NOT persist to disk; lives only for the process lifetime.
 *
 * Because an MSSQL connection is bound to a single database for its lifetime
 * (v1), the cache key omits a database component — connectionId already
 * encodes which database is in scope.
 *
 * §22.4 — Invalidation:
 *  - mssql:active-changed event → invalidate all entries for disconnected connections.
 *  - applyTableEdits success → caller calls mssqlBulkColumnsCache.invalidate(connectionId, schema).
 *  - Schema: Refresh → caller calls invalidate(connectionId).
 *  - Refresh columns button → caller calls invalidate(connectionId, schema) + refresh.
 */

import { columnsApi } from "./api";
import { mssqlApi } from "../api";
import type { BulkColumn, ColumnsBulkResult } from "../types";

export interface BulkColumnsCacheEntry {
  schema: string;
  /** Map from relation name → columns ordered by column_id. */
  columnsByRelation: Record<string, BulkColumn[]>;
  fetchedAt: number;
}

// -------------------------------------------------------------------
// Internal state
// -------------------------------------------------------------------

type EntryState =
  | { status: "ready"; entry: BulkColumnsCacheEntry }
  | { status: "fetching"; promise: Promise<BulkColumnsCacheEntry> };

/** Main cache: connectionId → (schema → EntryState) */
const cache = new Map<string, Map<string, EntryState>>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

function schemaMap(connectionId: string): Map<string, EntryState> {
  let m = cache.get(connectionId);
  if (!m) {
    m = new Map();
    cache.set(connectionId, m);
  }
  return m;
}

// -------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------

export const mssqlBulkColumnsCache = {
  /** Return a ready entry, or undefined if not yet populated. */
  get(connectionId: string, schema: string): BulkColumnsCacheEntry | undefined {
    const state = schemaMap(connectionId).get(schema);
    if (!state || state.status !== "ready") return undefined;
    return state.entry;
  },

  /** Store a bulk result directly (e.g. after a successful API call). */
  set(connectionId: string, schema: string, payload: ColumnsBulkResult): void {
    const entry: BulkColumnsCacheEntry = {
      schema,
      columnsByRelation: payload.columns_by_relation,
      fetchedAt: Date.now(),
    };
    schemaMap(connectionId).set(schema, { status: "ready", entry });
    notify();
  },

  /** Invalidate cache for one schema (or all schemas for a connection). */
  invalidate(connectionId: string, schema?: string): void {
    const m = cache.get(connectionId);
    if (!m) return;
    if (schema !== undefined) {
      m.delete(schema);
    } else {
      cache.delete(connectionId);
    }
    notify();
  },

  /**
   * Fetch (or return in-flight) bulk columns for `(connectionId, schema)`.
   * Idempotent: if the cache is already populated it returns immediately.
   * If a fetch is already in flight, the same promise is shared.
   */
  async refresh(
    connectionId: string,
    schema: string,
    origin: "auto" | "user" = "auto",
  ): Promise<BulkColumnsCacheEntry> {
    const m = schemaMap(connectionId);
    const existing = m.get(schema);

    // Already ready — return immediately without a new fetch.
    if (existing?.status === "ready") return existing.entry;

    // In-flight — share the existing promise.
    if (existing?.status === "fetching") return existing.promise;

    // Start a new fetch.
    const promise = columnsApi
      .listColumnsBulk(connectionId, schema, origin)
      .then((payload) => {
        const entry: BulkColumnsCacheEntry = {
          schema,
          columnsByRelation: payload.columns_by_relation,
          fetchedAt: Date.now(),
        };
        m.set(schema, { status: "ready", entry });
        notify();
        return entry;
      })
      .catch((err) => {
        // Remove the in-flight entry so the next attempt can retry.
        m.delete(schema);
        notify();
        throw err;
      });

    m.set(schema, { status: "fetching", promise });
    return promise;
  },

  /**
   * Return columns for a specific `(connectionId, schema, relation)` triple
   * from the cache, or undefined if the cache is not yet loaded.
   */
  getColumns(
    connectionId: string,
    schema: string,
    relation: string,
  ): BulkColumn[] | undefined {
    return mssqlBulkColumnsCache.get(connectionId, schema)?.columnsByRelation[relation];
  },

  /**
   * Subscribe to cache mutations. Returns an unsubscribe function.
   */
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /**
   * Returns true if a fetch for (connectionId, schema) is already populated
   * or in-flight — used by pre-warm to avoid duplicate fetches.
   */
  isPopulatedOrInFlight(connectionId: string, schema: string): boolean {
    return schemaMap(connectionId).has(schema);
  },

  /**
   * §22.4 — Clear all cached entries for a specific connection.
   * Called on disconnect (mssql:active-changed).
   */
  clearConnection(connectionId: string): void {
    const removed = cache.delete(connectionId);
    if (removed) notify();
  },

  /**
   * Return all schema names that have a "ready" cache entry for the
   * given connection. Used by the table quick-switcher (§23.1).
   */
  getPopulatedSchemas(connectionId: string): string[] {
    const m = cache.get(connectionId);
    if (!m) return [];
    const schemas: string[] = [];
    for (const [schema, state] of m) {
      if (state.status === "ready") schemas.push(schema);
    }
    return schemas;
  },

  /**
   * Return all relation names for a (connectionId, schema) pair from
   * the ready cache. Returns empty array when not populated.
   */
  getRelationNames(connectionId: string, schema: string): string[] {
    const state = schemaMap(connectionId).get(schema);
    if (!state || state.status !== "ready") return [];
    return Object.keys(state.entry.columnsByRelation);
  },
};

// ---------------------------------------------------------------------------
// §22.4 — Module-level disconnect listener.
// When Tauri emits `mssql:active-changed`, refresh the active list and
// clear cache entries for any connection no longer present.
// ---------------------------------------------------------------------------

if (
  typeof window !== "undefined" &&
  "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
) {
  import("@tauri-apps/api/event")
    .then(({ listen }) => {
      return listen<unknown>("mssql:active-changed", () => {
        mssqlApi
          .listActive()
          .then((active) => {
            const activeIds = new Set(active.map((a) => a.id));
            for (const connId of [...cache.keys()]) {
              if (!activeIds.has(connId)) {
                cache.delete(connId);
              }
            }
            notify();
          })
          .catch(() => {
            // Fire-and-forget; non-fatal.
          });
      });
    })
    .catch(() => {
      // Tauri listen not available — no-op (tests / non-Tauri builds).
    });
}
