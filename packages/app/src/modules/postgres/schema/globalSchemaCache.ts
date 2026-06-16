/**
 * Process-wide cache of schema-browser data, keyed by `connectionId`. The
 * sidebar's `useSchemaTree` populates schemas/relations as the user expands
 * them; a background bulk-fetch populates per-relation columns as soon as a
 * schema's relations load. The SQL editor reads from here for autocomplete
 * without triggering new IPCs.
 */

import type { Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import type { DataColumn } from "../data/types";
import type { RelationsResult, SchemaSummary } from "./types";

/**
 * Bulk-fetched column entry. Richer than `DataColumn` to support tooltips:
 * carries the column's default expression and row comment.
 */
export interface BulkColumnInfo {
  name: string;
  data_type: string;
  ordinal_position: number;
  is_nullable: boolean;
  default_value: string | null;
  comment: string | null;
}

interface ConnectionCache {
  schemas: SchemaSummary[];
  relationsBySchema: Map<string, RelationsResult>;
  /** Outer key: schema. Inner key: relation. */
  columnsByRelation: Map<string, Map<string, DataColumn[]>>;
  /** Bulk-fetched columns: outer key schema, inner key relation. Coexists
   * with `columnsByRelation` because the bulk shape carries richer info. */
  bulkColumnsByRelation: Map<string, Map<string, BulkColumnInfo[]>>;
}

const cache = new Map<string, ConnectionCache>();
const listeners = new Set<() => void>();
/** In-flight bulk fetches, keyed `<connectionId>:<schema>`. */
const inflightBulk = new Set<string>();

function notify() {
  listeners.forEach((l) => l());
}

function ensure(connectionId: string): ConnectionCache {
  let c = cache.get(connectionId);
  if (!c) {
    c = {
      schemas: [],
      relationsBySchema: new Map(),
      columnsByRelation: new Map(),
      bulkColumnsByRelation: new Map(),
    };
    cache.set(connectionId, c);
  }
  return c;
}

/** Heuristic: schemas Postgres ships with that we never autocomplete from. */
export function isSystemSchema(name: string): boolean {
  return name === "information_schema" || name.startsWith("pg_");
}

export const globalSchemaCache = {
  recordSchemas(connectionId: string, schemas: SchemaSummary[]) {
    const c = ensure(connectionId);
    c.schemas = schemas;
    notify();
  },
  recordRelations(connectionId: string, schema: string, relations: RelationsResult) {
    const c = ensure(connectionId);
    c.relationsBySchema.set(schema, relations);
    notify();
  },
  recordColumns(
    connectionId: string,
    schema: string,
    relation: string,
    columns: DataColumn[],
  ) {
    const c = ensure(connectionId);
    let bySchema = c.columnsByRelation.get(schema);
    if (!bySchema) {
      bySchema = new Map();
      c.columnsByRelation.set(schema, bySchema);
    }
    bySchema.set(relation, columns);
    notify();
  },
  /**
   * Ingest a bulk-fetched columns payload for a whole schema. Replaces any
   * prior bulk entries for that (connectionId, schema). Notifies subscribers
   * exactly once.
   */
  recordColumnsBulk(
    connectionId: string,
    schema: string,
    columnsByRelation: Map<string, BulkColumnInfo[]>,
  ) {
    const c = ensure(connectionId);
    c.bulkColumnsByRelation.set(schema, columnsByRelation);
    notify();
  },
  /** True if the (connectionId, schema) bulk fetch is in flight. */
  isBulkInflight(connectionId: string, schema: string): boolean {
    return inflightBulk.has(`${connectionId}:${schema}`);
  },
  /** True if bulk columns for the (connectionId, schema) are already cached. */
  hasBulkColumns(connectionId: string, schema: string): boolean {
    return cache.get(connectionId)?.bulkColumnsByRelation.has(schema) ?? false;
  },
  markBulkInflight(connectionId: string, schema: string) {
    inflightBulk.add(`${connectionId}:${schema}`);
  },
  clearBulkInflight(connectionId: string, schema: string) {
    inflightBulk.delete(`${connectionId}:${schema}`);
  },
  invalidate(connectionId: string) {
    const removed = cache.delete(connectionId);
    // Drop any in-flight markers for this connection too — the keys are
    // prefixed `<connectionId>:<schema>`.
    const prefix = `${connectionId}:`;
    for (const k of inflightBulk) {
      if (k.startsWith(prefix)) inflightBulk.delete(k);
    }
    if (removed) notify();
  },
  getSchemas(connectionId: string): SchemaSummary[] {
    return cache.get(connectionId)?.schemas ?? [];
  },
  getRelations(connectionId: string, schema: string): RelationsResult | null {
    return cache.get(connectionId)?.relationsBySchema.get(schema) ?? null;
  },
  getColumns(connectionId: string, schema: string, relation: string): DataColumn[] | null {
    return (
      cache.get(connectionId)?.columnsByRelation.get(schema)?.get(relation) ?? null
    );
  },
  /** All loaded relations across schemas, returned as flat list. */
  listAllRelations(connectionId: string): Array<{ schema: string; relation: string }> {
    const c = cache.get(connectionId);
    if (!c) return [];
    const out: Array<{ schema: string; relation: string }> = [];
    for (const [schema, payload] of c.relationsBySchema) {
      for (const t of payload.tables) out.push({ schema, relation: t.name });
      for (const v of payload.views) out.push({ schema, relation: v.name });
      for (const m of payload.materialized_views) out.push({ schema, relation: m.name });
    }
    return out;
  },
  /**
   * Build the `lang-sql`-compatible namespace from the bulk columns cache.
   * Excludes system schemas. Each leaf is a list of `Completion` objects so
   * the popup shows `data_type` as detail and `comment` (when present) in
   * the side panel.
   */
  getNamespace(connectionId: string): SQLNamespace {
    const c = cache.get(connectionId);
    if (!c) return {} as SQLNamespace;
    const out: Record<string, Record<string, readonly Completion[]>> = {};
    for (const [schemaName, relMap] of c.bulkColumnsByRelation) {
      if (isSystemSchema(schemaName)) continue;
      const inner: Record<string, readonly Completion[]> = {};
      for (const [relName, cols] of relMap) {
        inner[relName] = cols.map<Completion>((col) => ({
          label: col.name,
          type: "property",
          detail: col.data_type,
          info: col.comment ?? undefined,
        }));
      }
      // Skip schemas with no relations (would clutter the namespace).
      if (Object.keys(inner).length > 0) {
        out[schemaName] = inner;
      }
    }
    return out as SQLNamespace;
  },
  /**
   * Stable shape key for the namespace: `<schema>:<rel>,<rel>|<schema>:<rel>…`.
   * Lets QueryTab skip reconfigure when nothing structurally changed.
   */
  namespaceShapeKey(connectionId: string): string {
    const c = cache.get(connectionId);
    if (!c) return "";
    const parts: string[] = [];
    const schemaNames = Array.from(c.bulkColumnsByRelation.keys())
      .filter((n) => !isSystemSchema(n))
      .sort();
    for (const s of schemaNames) {
      const rels = Array.from(c.bulkColumnsByRelation.get(s)!.keys()).sort();
      parts.push(`${s}:${rels.join(",")}`);
    }
    return parts.join("|");
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
