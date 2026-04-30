import { useEffect, useMemo, useRef, useState } from "react";
import { schemaApi } from "@/modules/postgres/schema/api";
import { globalSchemaCache, isSystemSchema } from "@/modules/postgres/schema/globalSchemaCache";
import { useActiveConnections } from "@/modules/postgres/useActiveConnections";
import { useConnections } from "@/platform/connection-registry/useConnections";
import type { RelationKind } from "@/modules/postgres/data/types";

export interface TableEntry {
  connectionId: string;
  connectionName: string;
  schema: string;
  name: string;
  kind: RelationKind;
}

/** Module-scoped: dedupe `listRelations` fan-out across re-renders + remounts. */
const inflight = new Set<string>();

function flatten(
  connectionId: string,
  connectionName: string,
  cache: typeof globalSchemaCache,
): TableEntry[] {
  const out: TableEntry[] = [];
  for (const s of cache.getSchemas(connectionId)) {
    if (isSystemSchema(s.name)) continue;
    const rel = cache.getRelations(connectionId, s.name);
    if (!rel) continue;
    for (const t of rel.tables) {
      out.push({ connectionId, connectionName, schema: s.name, name: t.name, kind: "table" });
    }
    for (const v of rel.views) {
      out.push({ connectionId, connectionName, schema: s.name, name: v.name, kind: "view" });
    }
    for (const m of rel.materialized_views) {
      out.push({
        connectionId,
        connectionName,
        schema: s.name,
        name: m.name,
        kind: "materialized-view",
      });
    }
  }
  return out;
}

function compareEntries(a: TableEntry, b: TableEntry): number {
  if (a.connectionName !== b.connectionName)
    return a.connectionName.localeCompare(b.connectionName);
  if (a.schema !== b.schema) return a.schema.localeCompare(b.schema);
  return a.name.localeCompare(b.name);
}

/**
 * Reactive index of tables / views / materialized views across all active
 * Postgres connections. Re-derives on cache notifications, active-connection
 * changes, and connection-name changes.
 *
 * When `enabled` flips to true for the first time, fans out `listRelations`
 * for every (active connection, cached schema) where relations aren't yet
 * loaded. Schemas are not auto-listed — connections the user hasn't browsed
 * contribute nothing.
 */
export function useTableIndex(enabled: boolean): TableEntry[] {
  // Force re-derive when the schema cache notifies.
  const [cacheVersion, setCacheVersion] = useState(0);
  useEffect(
    () => globalSchemaCache.subscribe(() => setCacheVersion((v) => v + 1)),
    [],
  );

  const { items: actives } = useActiveConnections();
  const { items: connections } = useConnections();

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of connections) m.set(c.id, c.name);
    return m;
  }, [connections]);

  const entries = useMemo<TableEntry[]>(() => {
    const out: TableEntry[] = [];
    for (const a of actives) {
      const name = nameById.get(a.id);
      if (!name) continue;
      out.push(...flatten(a.id, name, globalSchemaCache));
    }
    out.sort(compareEntries);
    return out;
    // `cacheVersion` is the invalidation signal for `globalSchemaCache` reads,
    // even though it isn't referenced inside the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actives, nameById, cacheVersion]);

  // Eager-load on first enable. Once per hook lifetime; cache survives
  // disable→re-enable so subsequent opens don't refetch.
  const eagerLoadedRef = useRef(false);
  useEffect(() => {
    if (!enabled || eagerLoadedRef.current) return;
    eagerLoadedRef.current = true;
    for (const a of actives) {
      const schemas = globalSchemaCache.getSchemas(a.id);
      for (const s of schemas) {
        if (isSystemSchema(s.name)) continue;
        if (globalSchemaCache.getRelations(a.id, s.name)) continue;
        const key = `${a.id}:${s.name}`;
        if (inflight.has(key)) continue;
        inflight.add(key);
        schemaApi
          .listRelations(a.id, s.name)
          .then((res) => globalSchemaCache.recordRelations(a.id, s.name, res))
          .catch((e: unknown) => {
            console.warn("[argus.tableIndex] eager listRelations failed:", e);
          })
          .finally(() => inflight.delete(key));
      }
    }
  }, [enabled, actives]);

  return entries;
}
