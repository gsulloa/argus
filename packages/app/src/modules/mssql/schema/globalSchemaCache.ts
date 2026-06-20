/**
 * Process-wide cache of MSSQL schema-browser data, keyed by `connectionId`.
 * Slots per (connectionId, schema): relations (eager), structureProcedures,
 * structureFunctions, structureTriggers, structureSequences (all lazy),
 * perTableExtras (lazy per-table).
 *
 * Mirror of the MySQL globalSchemaCache — replace mysqlApi → mssqlApi, types.
 */

import type { RelationsResult, SchemaInfo, StructureResult, TableExtrasResult } from "../types";

interface ConnectionCache {
  schemas: SchemaInfo[];
  /** Epoch-ms when `schemas` was last recorded; drives the cache TTL. */
  schemasFetchedAt?: number;
  relationsBySchema: Map<string, RelationsResult>;
  structureBySchema: Map<string, StructureResult>;
  tableExtrasByKey: Map<string, TableExtrasResult>; // key = `${schema}::${relation}`
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
      structureBySchema: new Map(),
      tableExtrasByKey: new Map(),
    };
    cache.set(connectionId, c);
  }
  return c;
}

/** MSSQL system schemas hidden by default. */
export function isMssqlSystemSchema(name: string): boolean {
  return (
    name === "sys" ||
    name === "INFORMATION_SCHEMA" ||
    name === "db_owner" ||
    name === "db_accessadmin" ||
    name === "db_securityadmin" ||
    name === "db_ddladmin" ||
    name === "db_backupoperator" ||
    name === "db_datareader" ||
    name === "db_datawriter" ||
    name === "db_denydatareader" ||
    name === "db_denydatawriter" ||
    name === "guest"
  );
}

export const mssqlSchemaCache = {
  recordSchemas(connectionId: string, schemas: SchemaInfo[]) {
    const c = ensure(connectionId);
    c.schemas = schemas;
    c.schemasFetchedAt = Date.now();
    notify();
  },
  /** Epoch-ms when this connection's schemas were last recorded, or undefined. */
  getSchemasFetchedAt(connectionId: string): number | undefined {
    return cache.get(connectionId)?.schemasFetchedAt;
  },
  recordRelations(connectionId: string, schema: string, relations: RelationsResult) {
    const c = ensure(connectionId);
    c.relationsBySchema.set(schema, relations);
    notify();
  },
  recordStructure(connectionId: string, schema: string, structure: StructureResult) {
    const c = ensure(connectionId);
    c.structureBySchema.set(schema, structure);
    notify();
  },
  recordTableExtras(connectionId: string, schema: string, relation: string, extras: TableExtrasResult) {
    const c = ensure(connectionId);
    c.tableExtrasByKey.set(`${schema}::${relation}`, extras);
    notify();
  },
  invalidate(connectionId: string) {
    const removed = cache.delete(connectionId);
    if (removed) notify();
  },
  /** Invalidate a single group slot for a (connectionId, schema). */
  invalidateGroup(
    connectionId: string,
    schema: string,
    group: "relations" | "structure",
  ) {
    const c = cache.get(connectionId);
    if (!c) return;
    if (group === "relations") {
      c.relationsBySchema.delete(schema);
      notify();
    } else if (group === "structure") {
      c.structureBySchema.delete(schema);
      notify();
    }
  },
  invalidateTableExtras(connectionId: string, schema: string, relation: string) {
    const c = cache.get(connectionId);
    if (!c) return;
    c.tableExtrasByKey.delete(`${schema}::${relation}`);
    notify();
  },
  getSchemas(connectionId: string): SchemaInfo[] {
    return cache.get(connectionId)?.schemas ?? [];
  },
  getRelations(connectionId: string, schema: string): RelationsResult | null {
    return cache.get(connectionId)?.relationsBySchema.get(schema) ?? null;
  },
  getStructure(connectionId: string, schema: string): StructureResult | null {
    return cache.get(connectionId)?.structureBySchema.get(schema) ?? null;
  },
  getTableExtras(connectionId: string, schema: string, relation: string): TableExtrasResult | null {
    return cache.get(connectionId)?.tableExtrasByKey.get(`${schema}::${relation}`) ?? null;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
