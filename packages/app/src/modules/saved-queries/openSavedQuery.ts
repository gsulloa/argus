/**
 * Open a saved query in an existing or new tab.
 *
 * Reads the query from the saved-queries store and routes to either the
 * Postgres or MySQL query tab based on the associated connection's kind.
 * When no connection is associated (or the connection is not live), falls
 * back to the Postgres query tab (connection selector will be empty).
 */

import { openQueryTab, openSavedQueryInNewTab, type OpenQueryTabArgs } from "@/modules/postgres/sql/openQueryTab";
import { openMysqlQueryTab } from "@/modules/mysql/openMysqlQueryTab";
import { MYSQL_KIND } from "@/modules/mysql/types";
import { openMssqlQueryTab } from "@/modules/mssql/openMssqlQueryTab";
import { MSSQL_KIND } from "@/modules/mssql/types";
import { savedQueriesStore } from "./store";
import type { Tab } from "@/platform/shell/tabs/types";

interface TabsApi {
  tabs: Tab[];
  open: (input: {
    id?: string;
    kind: string;
    title: string;
    closable?: boolean;
    payload: unknown;
  }) => string;
  activate: (id: string) => void;
}

interface ConnectionRecord {
  id: string;
  name: string;
  kind?: string;
}

interface ConnectionRegistry {
  items: ConnectionRecord[];
}

function buildArgs(queryId: string, connections: ConnectionRecord[]): OpenQueryTabArgs | null {
  const snapshot = savedQueriesStore.getSnapshot();
  const q = snapshot.queries.find((x) => x.id === queryId);
  if (!q) return null;

  const conn = q.last_connection_id
    ? connections.find((c) => c.id === q.last_connection_id) ?? null
    : null;

  return {
    initialConnectionId: conn?.id,
    initialConnectionName: conn?.name,
    initialSql: q.sql,
    savedQueryId: q.id,
  };
}

/**
 * Open or focus the tab for a saved query. If a tab is already open for this
 * query it will be focused; otherwise a new tab is opened.
 *
 * Routes to the correct tab kind based on the associated connection's kind:
 * - MySQL connections → mysql-query tab (always new tab; no dedup by savedQueryId)
 * - All other connections → postgres query tab
 *
 * If `last_connection_id` references a connection not in the registry,
 * `initialConnectionId` will be undefined — the selector opens empty.
 */
export function openSavedQuery(
  tabs: TabsApi,
  connections: ConnectionRegistry,
  queryId: string,
): void {
  const snapshot = savedQueriesStore.getSnapshot();
  const q = snapshot.queries.find((x) => x.id === queryId);
  if (!q) {
    console.warn(`[saved-queries] openSavedQuery: query "${queryId}" not found in store.`);
    return;
  }

  const conn = q.last_connection_id
    ? connections.items.find((c) => c.id === q.last_connection_id) ?? null
    : null;

  if (conn?.kind === MYSQL_KIND) {
    openMysqlQueryTab(tabs, {
      connectionId: conn.id,
      connectionName: conn.name,
      sql: q.sql,
    });
    return;
  }

  if (conn?.kind === MSSQL_KIND) {
    openMssqlQueryTab(tabs, {
      connectionId: conn.id,
      connectionName: conn.name,
      sql: q.sql,
    });
    return;
  }

  const args = buildArgs(queryId, connections.items);
  if (!args) return;
  openQueryTab(tabs, args);
}

/**
 * Always open a new tab, even if one exists for this saved query.
 */
export function openSavedQueryInNew(
  tabs: TabsApi,
  connections: ConnectionRegistry,
  queryId: string,
): void {
  const snapshot = savedQueriesStore.getSnapshot();
  const q = snapshot.queries.find((x) => x.id === queryId);
  if (!q) {
    console.warn(`[saved-queries] openSavedQueryInNew: query "${queryId}" not found in store.`);
    return;
  }

  const conn = q.last_connection_id
    ? connections.items.find((c) => c.id === q.last_connection_id) ?? null
    : null;

  if (conn?.kind === MYSQL_KIND) {
    openMysqlQueryTab(tabs, {
      connectionId: conn.id,
      connectionName: conn.name,
      sql: q.sql,
    });
    return;
  }

  if (conn?.kind === MSSQL_KIND) {
    openMssqlQueryTab(tabs, {
      connectionId: conn.id,
      connectionName: conn.name,
      sql: q.sql,
    });
    return;
  }

  const args = buildArgs(queryId, connections.items);
  if (!args) return;
  openSavedQueryInNewTab(tabs, args);
}
