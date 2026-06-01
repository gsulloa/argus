/**
 * Tiny event bus for MSSQL schema-browser coordination between palette commands
 * and per-connection SchemaTree instances. Mirror of MySQL/Postgres schema events.
 */

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
