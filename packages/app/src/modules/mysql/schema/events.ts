/**
 * Tiny event bus for MySQL schema-browser coordination between palette commands
 * and per-connection SchemaTree instances. Mirror of Postgres schema events.
 */

import { mysqlSchemaCache } from "./globalSchemaCache";

export type MysqlSchemaEvent =
  | { type: "invalidate"; connectionId: string }
  | { type: "openPicker"; connectionId: string };

type Listener = (e: MysqlSchemaEvent) => void;

const listeners = new Set<Listener>();

export function emitMysqlSchemaEvent(event: MysqlSchemaEvent): void {
  for (const l of listeners) l(event);
}

export function subscribeMysqlSchemaEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Force a full reload of one connection's schema tree: drop its process-wide
 * cache entry (so the tree can't re-seed from stale data) and signal the
 * mounted tree to invalidate and refetch. Single entry point used by the
 * palette `Schema: Refresh` command and the global `Cmd+R` accelerator.
 */
export function refreshConnection(connectionId: string): void {
  mysqlSchemaCache.invalidate(connectionId);
  emitMysqlSchemaEvent({ type: "invalidate", connectionId });
}
