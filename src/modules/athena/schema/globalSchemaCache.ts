/**
 * Process-wide cache of Athena schema-browser data, keyed by `connectionId`.
 * Two slots per connectionId: databases (eager list) and relations per database.
 * Does NOT persist to disk.
 *
 * Mirror of mysqlSchemaCache — replaces MySQL types with Athena types.
 */

import type { AthenaDatabaseInfo, AthenaRelationInfo } from "../types";

interface ConnectionCache {
  databases: AthenaDatabaseInfo[];
  relationsByDatabase: Map<string, AthenaRelationInfo[]>;
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
    };
    cache.set(connectionId, c);
  }
  return c;
}

export const athenaSchemaCache = {
  recordDatabases(connectionId: string, databases: AthenaDatabaseInfo[]) {
    const c = ensure(connectionId);
    c.databases = databases;
    notify();
  },

  recordRelations(connectionId: string, database: string, relations: AthenaRelationInfo[]) {
    const c = ensure(connectionId);
    c.relationsByDatabase.set(database, relations);
    notify();
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
