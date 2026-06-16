/**
 * Tiny event bus that lets the palette commands and other app-root effects
 * coordinate with per-connection `<SchemaTree>` instances. The tree owns the
 * cache, so we can't invalidate it from outside without a channel.
 */

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
