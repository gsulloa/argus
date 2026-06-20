/**
 * Tiny event bus for MSSQL schema-browser coordination between palette commands
 * and per-connection SchemaTree instances. Mirror of MySQL/Postgres schema events.
 */

import { mssqlSchemaCache } from "./globalSchemaCache";

export type MssqlSchemaEvent =
  | { type: "invalidate"; connectionId: string }
  | { type: "openPicker"; connectionId: string };

type Listener = (e: MssqlSchemaEvent) => void;

const listeners = new Set<Listener>();

export function emitMssqlSchemaEvent(event: MssqlSchemaEvent): void {
  for (const l of listeners) l(event);
}

export function subscribeMssqlSchemaEvent(fn: Listener): () => void {
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
  mssqlSchemaCache.invalidate(connectionId);
  emitMssqlSchemaEvent({ type: "invalidate", connectionId });
}
