/**
 * Process-wide cache of Athena schema-browser data, keyed by `connectionId`.
 * Two slots per connectionId: databases (eager list) and relations per database.
 * Does NOT persist to disk.
 *
 * Mirror of mysqlSchemaCache — replaces MySQL types with Athena types.
 */

import type { AthenaDatabaseInfo, AthenaNamedQuerySummary, AthenaRelationInfo } from "../types";

interface ConnectionCache {
  databases: AthenaDatabaseInfo[];
  /** Epoch-ms when `databases` was last recorded; drives the cache TTL. */
  databasesFetchedAt?: number;
  relationsByDatabase: Map<string, AthenaRelationInfo[]>;
  namedQueries: AthenaNamedQuerySummary[] | null;
}

const cache = new Map<string, ConnectionCache>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

function ensure(connectionId: string): ConnectionCache {
  let c = cache.get(connectionId);
  if (!c) {
    c = {
      databases: [],
      relationsByDatabase: new Map(),
      namedQueries: null,
    };
    cache.set(connectionId, c);
  }
  return c;
}

export const athenaSchemaCache = {
  recordDatabases(connectionId: string, databases: AthenaDatabaseInfo[]) {
    const c = ensure(connectionId);
    c.databases = databases;
    c.databasesFetchedAt = Date.now();
    notify();
  },

  /** Epoch-ms when this connection's databases were last recorded, or undefined. */
  getDatabasesFetchedAt(connectionId: string): number | undefined {
    return cache.get(connectionId)?.databasesFetchedAt;
  },

  recordRelations(connectionId: string, database: string, relations: AthenaRelationInfo[]) {
    const c = ensure(connectionId);
    c.relationsByDatabase.set(database, relations);
    notify();
  },

  recordNamedQueries(connectionId: string, queries: AthenaNamedQuerySummary[]) {
    const c = ensure(connectionId);
    c.namedQueries = queries;
    notify();
  },

  getNamedQueries(connectionId: string): AthenaNamedQuerySummary[] | null {
    return cache.get(connectionId)?.namedQueries ?? null;
  },

  invalidate(connectionId: string) {
    const removed = cache.delete(connectionId);
    if (removed) notify();
  },

  getDatabases(connectionId: string): AthenaDatabaseInfo[] {
    return cache.get(connectionId)?.databases ?? [];
  },

  getRelations(connectionId: string, database: string): AthenaRelationInfo[] | null {
    return cache.get(connectionId)?.relationsByDatabase.get(database) ?? null;
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
