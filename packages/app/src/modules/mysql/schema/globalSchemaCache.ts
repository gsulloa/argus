/**
 * Process-wide cache of MySQL schema-browser data, keyed by `connectionId`.
 * Three slots per (connectionId, schema): relations (eager), structure (lazy),
 * tableExtras (lazy per-table). Does NOT persist to disk.
 *
 * Mirror of the Postgres globalSchemaCache — replace pgApi → mysqlApi, types.
 */

import type { RelationsResult, SchemaInfo } from "../types";

interface ConnectionCache {
  schemas: SchemaInfo[];
  relationsBySchema: Map<string, RelationsResult>;
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
      schemas: [],
      relationsBySchema: new Map(),
    };
    cache.set(connectionId, c);
  }
  return c;
}

/** MySQL system schemas hidden by default. */
export function isMysqlSystemSchema(name: string): boolean {
  return (
    name === "mysql" ||
    name === "information_schema" ||
    name === "performance_schema" ||
    name === "sys"
  );
}

export const mysqlSchemaCache = {
  recordSchemas(connectionId: string, schemas: SchemaInfo[]) {
    const c = ensure(connectionId);
    c.schemas = schemas;
    notify();
  },
  recordRelations(connectionId: string, schema: string, relations: RelationsResult) {
    const c = ensure(connectionId);
    c.relationsBySchema.set(schema, relations);
    notify();
  },
  invalidate(connectionId: string) {
    const removed = cache.delete(connectionId);
    if (removed) notify();
  },
  /** Invalidate a single group slot for a (connectionId, schema). Currently
   *  removes the whole schema entry — the hook manages per-slot state. */
  invalidateGroup(connectionId: string, schema: string, _group: "relations" | "structure") {
    const c = cache.get(connectionId);
    if (!c) return;
    if (_group === "relations") {
      c.relationsBySchema.delete(schema);
      notify();
    }
  },
  getSchemas(connectionId: string): SchemaInfo[] {
    return cache.get(connectionId)?.schemas ?? [];
  },
  getRelations(connectionId: string, schema: string): RelationsResult | null {
    return cache.get(connectionId)?.relationsBySchema.get(schema) ?? null;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
