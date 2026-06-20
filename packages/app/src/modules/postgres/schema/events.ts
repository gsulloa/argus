/**
 * Tiny event bus that lets the palette commands and other app-root effects
 * coordinate with per-connection `<SchemaTree>` instances. The tree owns the
 * cache, so we can't invalidate it from outside without a channel.
 */

import { globalSchemaCache } from "./globalSchemaCache";

export type SchemaEvent =
  | { type: "invalidate"; connectionId: string }
  | { type: "openPicker"; connectionId: string };

type Listener = (e: SchemaEvent) => void;

const listeners = new Set<Listener>();

export function emitSchemaEvent(event: SchemaEvent): void {
  for (const l of listeners) l(event);
}

export function subscribeSchemaEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Force a full reload of one connection's schema tree: drop its process-wide
 * cache entry (so the tree can't re-seed from stale data) and signal the
 * mounted `<SchemaTree>` to invalidate and refetch. This is the single entry
 * point used by the palette `Schema: Refresh` command and the global
 * `Cmd+R` / `Ctrl+R` accelerator.
 */
export function refreshConnection(connectionId: string): void {
  globalSchemaCache.invalidate(connectionId);
  emitSchemaEvent({ type: "invalidate", connectionId });
}
