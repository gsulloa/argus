import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { schemaApi } from "@/modules/postgres/schema/api";
import { globalSchemaCache, isSystemSchema } from "@/modules/postgres/schema/globalSchemaCache";
import { useActiveConnections } from "@/modules/postgres/useActiveConnections";
import { useActiveMysqlConnections } from "@/modules/mysql/useActiveConnections";
import { mysqlSchemaCache, isMysqlSystemSchema } from "@/modules/mysql/schema/globalSchemaCache";
import { mysqlBulkColumnsCache } from "@/modules/mysql/sql/columnsCache";
import { schemaApi as mysqlSchemaApi } from "@/modules/mysql/schema/api";
import { useActiveMssqlConnections } from "@/modules/mssql/useActiveConnections";
import { mssqlSchemaCache, isMssqlSystemSchema } from "@/modules/mssql/schema/globalSchemaCache";
import { mssqlBulkColumnsCache } from "@/modules/mssql/columns/columnsCache";
import { schemaApi as mssqlSchemaApi } from "@/modules/mssql/schema/api";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { useOpenConnections } from "@/platform/connection-registry/useOpenConnections";
import { FocusedConnectionCtxRef } from "@/platform/shell/FocusedConnectionContext";
import type { RelationKind } from "@/modules/postgres/data/types";
import type { TableScope } from "@/platform/command-palette/PaletteContext";

/** Connection kind tag — determines how to open the tab. */
export type TableEntryKind = "postgres" | "mysql" | "mssql";

export interface TableEntry {
  connectionId: string;
  connectionName: string;
  schema: string;
  name: string;
  kind: RelationKind;
  /**
   * Which driver owns this connection. Defaults to "postgres" when absent
   * (backward-compatible with entries stored before MySQL support was added).
   */
  connectionKind?: TableEntryKind;
}

/** Module-scoped: dedupe `listRelations` fan-out across re-renders + remounts. */
const inflight = new Set<string>();
/** Module-scoped: dedupe mysql lazy-load fan-out. */
const mysqlInflight = new Set<string>();
/** Module-scoped: dedupe mssql lazy-load fan-out. */
const mssqlInflight = new Set<string>();

function flattenPostgres(
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
      out.push({ connectionId, connectionName, schema: s.name, name: t.name, kind: "table", connectionKind: "postgres" });
    }
    for (const v of rel.views) {
      out.push({ connectionId, connectionName, schema: s.name, name: v.name, kind: "view", connectionKind: "postgres" });
    }
    for (const m of rel.materialized_views) {
      out.push({
        connectionId,
        connectionName,
        schema: s.name,
        name: m.name,
        kind: "materialized-view",
        connectionKind: "postgres",
      });
    }
  }
  return out;
}

/**
 * Enumerate MySQL tables/views from the bulk columns cache (fast, already
 * warm from SQL editor opens) or from the schema relations cache (populated
 * after schema-browser browsing). Lazy-loads relations for schemas that are
 * cached but whose relations haven't been fetched yet.
 */
function flattenMysql(
  connectionId: string,
  connectionName: string,
): TableEntry[] {
  const out: TableEntry[] = [];

  // Primary source: mysqlBulkColumnsCache (populated by SQL editor pre-warm).
  const bulkSchemas = mysqlBulkColumnsCache.getPopulatedSchemas(connectionId);
  const seenFromBulk = new Set<string>();
  for (const schema of bulkSchemas) {
    const relNames = mysqlBulkColumnsCache.getRelationNames(connectionId, schema);
    for (const name of relNames) {
      const key = `${schema}:${name}`;
      seenFromBulk.add(key);
      // Bulk cache doesn't distinguish tables vs views; default to "table".
      out.push({ connectionId, connectionName, schema, name, kind: "table", connectionKind: "mysql" });
    }
  }

  // Secondary source: mysqlSchemaCache relations (populated by schema-browser).
  for (const s of mysqlSchemaCache.getSchemas(connectionId)) {
    if (isMysqlSystemSchema(s.name)) continue;
    const rel = mysqlSchemaCache.getRelations(connectionId, s.name);
    if (!rel) continue;
    for (const t of rel.tables) {
      const key = `${s.name}:${t.name}`;
      if (!seenFromBulk.has(key)) {
        out.push({ connectionId, connectionName, schema: s.name, name: t.name, kind: "table", connectionKind: "mysql" });
      }
    }
    for (const v of rel.views) {
      const key = `${s.name}:${v.name}`;
      if (!seenFromBulk.has(key)) {
        out.push({ connectionId, connectionName, schema: s.name, name: v.name, kind: "view", connectionKind: "mysql" });
      }
    }
  }
  return out;
}

/**
 * Enumerate MSSQL tables/views from the bulk columns cache (fast, already
 * warm from SQL editor opens) or from the schema relations cache (populated
 * after schema-browser browsing). Lazy-loads relations for schemas that are
 * cached but whose relations haven't been fetched yet.
 */
function flattenMssql(
  connectionId: string,
  connectionName: string,
): TableEntry[] {
  const out: TableEntry[] = [];

  // Primary source: mssqlBulkColumnsCache (populated by SQL editor pre-warm).
  const bulkSchemas = mssqlBulkColumnsCache.getPopulatedSchemas(connectionId);
  const seenFromBulk = new Set<string>();
  for (const schema of bulkSchemas) {
    const relNames = mssqlBulkColumnsCache.getRelationNames(connectionId, schema);
    for (const name of relNames) {
      const key = `${schema}:${name}`;
      seenFromBulk.add(key);
      // Bulk cache doesn't distinguish tables vs views; default to "table".
      out.push({ connectionId, connectionName, schema, name, kind: "table", connectionKind: "mssql" });
    }
  }

  // Secondary source: mssqlSchemaCache relations (populated by schema-browser).
  for (const s of mssqlSchemaCache.getSchemas(connectionId)) {
    if (isMssqlSystemSchema(s.name)) continue;
    const rel = mssqlSchemaCache.getRelations(connectionId, s.name);
    if (!rel) continue;
    for (const t of rel.tables) {
      const key = `${s.name}:${t.name}`;
      if (!seenFromBulk.has(key)) {
        out.push({ connectionId, connectionName, schema: s.name, name: t.name, kind: "table", connectionKind: "mssql" });
      }
    }
    for (const v of rel.views) {
      const key = `${s.name}:${v.name}`;
      if (!seenFromBulk.has(key)) {
        out.push({ connectionId, connectionName, schema: s.name, name: v.name, kind: "view", connectionKind: "mssql" });
      }
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
 * Reactive index of tables / views / materialized views scoped to either the
 * focused connection or all open connections.
 *
 * - `scope: "focused"` — only the focused connection's relations (Decision 6).
 *   Used by ⌘P.  Index rebuilds reactively when `focusedConnectionId` changes
 *   or a connection closes.
 * - `scope: "all-open"` — every currently-open connection, bounded to the
 *   cross-engine open registry.  Used by ⌥⌘P.
 *
 * When `enabled` flips to true for the first time, fans out `listRelations`
 * for every (scoped connection, cached schema) where relations aren't yet
 * loaded. Eager fan-out is bounded to the active scope.
 */
export function useTableIndex(enabled: boolean, scope: TableScope = "all-open"): TableEntry[] {
  // Force re-derive when any schema cache notifies.
  const [pgCacheVersion, setPgCacheVersion] = useState(0);
  const [myCacheVersion, setMyCacheVersion] = useState(0);
  const [msCacheVersion, setMsCacheVersion] = useState(0);
  useEffect(
    () => globalSchemaCache.subscribe(() => setPgCacheVersion((v) => v + 1)),
    [],
  );
  useEffect(
    () => mysqlSchemaCache.subscribe(() => setMyCacheVersion((v) => v + 1)),
    [],
  );
  useEffect(
    () => mysqlBulkColumnsCache.subscribe(() => setMyCacheVersion((v) => v + 1)),
    [],
  );
  useEffect(
    () => mssqlSchemaCache.subscribe(() => setMsCacheVersion((v) => v + 1)),
    [],
  );
  useEffect(
    () => mssqlBulkColumnsCache.subscribe(() => setMsCacheVersion((v) => v + 1)),
    [],
  );

  const { items: pgActives } = useActiveConnections();
  const { items: myActives } = useActiveMysqlConnections();
  const { items: msActives } = useActiveMssqlConnections();
  const { items: connections } = useConnections();
  // Open-connections registry: used to constrain "all-open" to only live connections.
  const { isOpen } = useOpenConnections();
  // FocusedConnectionContext: drives the "focused" scope filter.
  // Read the context directly (not through useFocusedConnection) so that this
  // hook is safe outside of FocusedConnectionProvider (e.g. Manager window,
  // tests). When the context is absent, scope="focused" degrades to empty.
  const focusedCtx = useContext(FocusedConnectionCtxRef);
  const focusedConnectionId = focusedCtx?.focusedConnectionId ?? null;

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of connections) m.set(c.id, c.name);
    return m;
  }, [connections]);

  // Compute the set of connection ids that are in scope.
  const scopedIds = useMemo<Set<string>>(() => {
    if (scope === "focused") {
      return focusedConnectionId ? new Set([focusedConnectionId]) : new Set();
    }
    // "all-open": all per-engine active connections that are also in the open registry.
    const ids = new Set<string>();
    for (const a of pgActives) if (isOpen(a.id)) ids.add(a.id);
    for (const a of myActives) if (isOpen(a.id)) ids.add(a.id);
    for (const a of msActives) if (isOpen(a.id)) ids.add(a.id);
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, focusedConnectionId, pgActives, myActives, msActives, isOpen]);

  const entries = useMemo<TableEntry[]>(() => {
    const out: TableEntry[] = [];
    for (const a of pgActives) {
      if (!scopedIds.has(a.id)) continue;
      const name = nameById.get(a.id);
      if (!name) continue;
      out.push(...flattenPostgres(a.id, name, globalSchemaCache));
    }
    for (const a of myActives) {
      if (!scopedIds.has(a.id)) continue;
      const name = nameById.get(a.id);
      if (!name) continue;
      out.push(...flattenMysql(a.id, name));
    }
    for (const a of msActives) {
      if (!scopedIds.has(a.id)) continue;
      const name = nameById.get(a.id);
      if (!name) continue;
      out.push(...flattenMssql(a.id, name));
    }
    out.sort(compareEntries);
    return out;
    // pgCacheVersion, myCacheVersion, msCacheVersion are invalidation signals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pgActives, myActives, msActives, nameById, scopedIds, pgCacheVersion, myCacheVersion, msCacheVersion]);

  // Eager-load on first enable — bounded to the active scope.
  const eagerLoadedRef = useRef(false);
  useEffect(() => {
    if (!enabled || eagerLoadedRef.current) return;
    eagerLoadedRef.current = true;

    // Postgres: lazy-load uncached relations (scoped).
    for (const a of pgActives) {
      if (!scopedIds.has(a.id)) continue;
      const schemas = globalSchemaCache.getSchemas(a.id);
      for (const s of schemas) {
        if (isSystemSchema(s.name)) continue;
        if (globalSchemaCache.getRelations(a.id, s.name)) continue;
        const key = `pg:${a.id}:${s.name}`;
        if (inflight.has(key)) continue;
        inflight.add(key);
        schemaApi
          .listRelations(a.id, s.name)
          .then((res) => globalSchemaCache.recordRelations(a.id, s.name, res))
          .catch((e: unknown) => {
            console.warn("[argus.tableIndex] pg eager listRelations failed:", e);
          })
          .finally(() => inflight.delete(key));
      }
    }

    // MySQL: lazy-load bulk columns cache for warm schemas without bulk data (scoped).
    for (const a of myActives) {
      if (!scopedIds.has(a.id)) continue;
      for (const s of mysqlSchemaCache.getSchemas(a.id)) {
        if (isMysqlSystemSchema(s.name)) continue;
        if (mysqlBulkColumnsCache.isPopulatedOrInFlight(a.id, s.name)) continue;
        const key = `my:${a.id}:${s.name}`;
        if (mysqlInflight.has(key)) continue;
        mysqlInflight.add(key);
        mysqlBulkColumnsCache
          .refresh(a.id, s.name, "auto")
          .catch((e: unknown) => {
            console.warn("[argus.tableIndex] mysql bulk columns failed:", e);
          })
          .finally(() => mysqlInflight.delete(key));
      }

      // Also lazy-load MySQL schema relations if not yet fetched.
      for (const s of mysqlSchemaCache.getSchemas(a.id)) {
        if (isMysqlSystemSchema(s.name)) continue;
        if (mysqlSchemaCache.getRelations(a.id, s.name)) continue;
        const key = `myrel:${a.id}:${s.name}`;
        if (mysqlInflight.has(key)) continue;
        mysqlInflight.add(key);
        mysqlSchemaApi
          .listRelations(a.id, s.name)
          .then((res) => mysqlSchemaCache.recordRelations(a.id, s.name, res))
          .catch((e: unknown) => {
            console.warn("[argus.tableIndex] mysql eager listRelations failed:", e);
          })
          .finally(() => mysqlInflight.delete(key));
      }
    }

    // MSSQL: lazy-load bulk columns cache for warm schemas without bulk data (scoped).
    for (const a of msActives) {
      if (!scopedIds.has(a.id)) continue;
      for (const s of mssqlSchemaCache.getSchemas(a.id)) {
        if (isMssqlSystemSchema(s.name)) continue;
        if (mssqlBulkColumnsCache.isPopulatedOrInFlight(a.id, s.name)) continue;
        const key = `ms:${a.id}:${s.name}`;
        if (mssqlInflight.has(key)) continue;
        mssqlInflight.add(key);
        mssqlBulkColumnsCache
          .refresh(a.id, s.name, "auto")
          .catch((e: unknown) => {
            console.warn("[argus.tableIndex] mssql bulk columns failed:", e);
          })
          .finally(() => mssqlInflight.delete(key));
      }

      // Also lazy-load MSSQL schema relations if not yet fetched.
      for (const s of mssqlSchemaCache.getSchemas(a.id)) {
        if (isMssqlSystemSchema(s.name)) continue;
        if (mssqlSchemaCache.getRelations(a.id, s.name)) continue;
        const key = `msrel:${a.id}:${s.name}`;
        if (mssqlInflight.has(key)) continue;
        mssqlInflight.add(key);
        mssqlSchemaApi
          .listRelations(a.id, s.name)
          .then((res) => mssqlSchemaCache.recordRelations(a.id, s.name, res))
          .catch((e: unknown) => {
            console.warn("[argus.tableIndex] mssql eager listRelations failed:", e);
          })
          .finally(() => mssqlInflight.delete(key));
      }
    }
  }, [enabled, pgActives, myActives, msActives, scopedIds]);

  return entries;
}
