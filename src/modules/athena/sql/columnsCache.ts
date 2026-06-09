/**
 * Athena bulk columns cache.
 *
 * Process-wide in-memory cache keyed by `(connectionId, database, relation)`.
 * Populated when the schema tree expands a relation leaf.
 * Does NOT persist to disk; lives only for the process lifetime.
 *
 * Invalidation:
 *  - athena:active-changed event → clear cache entries for disconnected connections.
 */

import { athenaApi } from "../api";
import type { AthenaColumnInfo } from "../types";

/** Main cache: connectionId → (database → (relation → column[])) */
const cache = new Map<string, Map<string, Map<string, AthenaColumnInfo[]>>>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

function getOrCreateDbMap(connectionId: string): Map<string, Map<string, AthenaColumnInfo[]>> {
  let m = cache.get(connectionId);
  if (!m) {
    m = new Map();
    cache.set(connectionId, m);
  }
  return m;
}

function getOrCreateRelMap(connectionId: string, database: string): Map<string, AthenaColumnInfo[]> {
  const dbMap = getOrCreateDbMap(connectionId);
  let m = dbMap.get(database);
  if (!m) {
    m = new Map();
    dbMap.set(database, m);
  }
  return m;
}

export const athenaColumnsCache = {
  /** Store columns for a (connectionId, database, relation) triple. */
  setColumns(connectionId: string, database: string, relation: string, cols: AthenaColumnInfo[]): void {
    getOrCreateRelMap(connectionId, database).set(relation, cols);
    notify();
  },

  /** Return columns for a specific triple, or undefined if not yet populated. */
  getColumns(connectionId: string, database: string, relation: string): AthenaColumnInfo[] | undefined {
    return cache.get(connectionId)?.get(database)?.get(relation);
  },

  /** Return all database names that have columns cached for this connection. */
  getDatabases(connectionId: string): string[] {
    const m = cache.get(connectionId);
    if (!m) return [];
    return [...m.keys()];
  },

  /** Return all relation names for a (connectionId, database) pair from cache. */
  getRelationNames(connectionId: string, database: string): string[] {
    const m = cache.get(connectionId)?.get(database);
    if (!m) return [];
    return [...m.keys()];
  },

  /** Invalidate all cached entries for a specific connection. */
  clearConnection(connectionId: string): void {
    const removed = cache.delete(connectionId);
    if (removed) notify();
  },

  /** Subscribe to cache mutations. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// ---------------------------------------------------------------------------
// Module-level disconnect listener.
// When Tauri emits `athena:active-changed`, clear cache entries for any
// connection no longer present.
// ---------------------------------------------------------------------------

if (
  typeof window !== "undefined" &&
  "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
) {
  import("@tauri-apps/api/event")
    .then(({ listen }) => {
      return listen<unknown>("athena:active-changed", () => {
        athenaApi
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
