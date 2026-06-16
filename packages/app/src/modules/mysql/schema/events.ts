/**
 * Tiny event bus for MySQL schema-browser coordination between palette commands
 * and per-connection SchemaTree instances. Mirror of Postgres schema events.
 */

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
