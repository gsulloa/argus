/**
 * Open a saved query in an existing or new tab.
 *
 * Reads the query from the saved-queries store, switches focus to the query's
 * connection (if it is currently open), then routes to the correct engine tab.
 *
 * Resolution order:
 * 1. If the query has an associated connection AND that connection is currently
 *    open: call `ctx.setFocused(conn.id)` first, then open the tab in that
 *    connection's set.  Returns `"opened"`.
 * 2. If the connection is not open (or the query has no connection), but there
 *    IS a focused connection: open a Postgres query tab against the focused
 *    connection with an empty connection selector (the SQL is still pre-filled).
 *    Returns `"opened"`.
 * 3. If there is no live connection AND no focused connection: returns
 *    `"no-target"` — the caller should show a toast.
 * 4. If the query id is not found in the store: returns `"not-found"`.
 */

import { openQueryTab, openSavedQueryInNewTab, type OpenQueryTabArgs } from "@/modules/postgres/sql/openQueryTab";
import { openMysqlQueryTab } from "@/modules/mysql/openMysqlQueryTab";
import { MYSQL_KIND } from "@/modules/mysql/types";
import { openMssqlQueryTab } from "@/modules/mssql/openMssqlQueryTab";
import { MSSQL_KIND } from "@/modules/mssql/types";
import { savedQueriesStore } from "./store";
import type { Tab } from "@/platform/shell/tabs/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OpenSavedQueryCtx {
  focusedConnectionId: string | null;
  setFocused: (id: string) => void;
  isOpen: (connectionId: string) => boolean;
}

export type OpenSavedQueryResult = "opened" | "not-found" | "no-target";

// ---------------------------------------------------------------------------
// Internal interfaces (not exported — shared with openQueryTab.ts shapes)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Shared implementation helper
// ---------------------------------------------------------------------------

type PostgresHelper = (tabs: TabsApi, args: OpenQueryTabArgs) => string;

function openSavedQueryImpl(
  tabs: TabsApi,
  connections: ConnectionRegistry,
  queryId: string,
  ctx: OpenSavedQueryCtx,
  postgresHelper: PostgresHelper,
  fnName: string,
): OpenSavedQueryResult {
  const snapshot = savedQueriesStore.getSnapshot();
  const q = snapshot.queries.find((x) => x.id === queryId);
  if (!q) {
    console.warn(`[saved-queries] ${fnName}: query "${queryId}" not found in store.`);
    return "not-found";
  }

  const conn = q.last_connection_id
    ? connections.items.find((c) => c.id === q.last_connection_id) ?? null
    : null;

  // ---- Live-connection path ----
  if (conn !== null && ctx.isOpen(conn.id)) {
    ctx.setFocused(conn.id);

    if (conn.kind === MYSQL_KIND) {
      openMysqlQueryTab(tabs, {
        connectionId: conn.id,
        connectionName: conn.name,
        sql: q.sql,
      });
      return "opened";
    }

    if (conn.kind === MSSQL_KIND) {
      openMssqlQueryTab(tabs, {
        connectionId: conn.id,
        connectionName: conn.name,
        sql: q.sql,
      });
      return "opened";
    }

    // Postgres (or unknown engine treated as Postgres)
    postgresHelper(tabs, {
      initialConnectionId: conn.id,
      initialConnectionName: conn.name,
      initialSql: q.sql,
      savedQueryId: q.id,
    });
    return "opened";
  }

  // ---- Fallback path: use the focused connection ----
  if (ctx.focusedConnectionId !== null) {
    postgresHelper(tabs, {
      initialConnectionId: undefined,
      initialConnectionName: undefined,
      initialSql: q.sql,
      savedQueryId: q.id,
    });
    return "opened";
  }

  // ---- No live connection, no focused connection ----
  return "no-target";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open or focus the tab for a saved query. If a tab is already open for this
 * query it will be focused; otherwise a new tab is opened.
 *
 * Routes to the correct tab kind based on the associated connection's kind:
 * - MySQL connections → mysql-query tab
 * - MSSQL connections → mssql-query tab
 * - All other connections → postgres query tab (with savedQueryId dedup)
 *
 * Switches focus to the query's connection before opening the tab so the tab
 * is immediately visible (tabs are scoped to the focused connection's set).
 */
export function openSavedQuery(
  tabs: TabsApi,
  connections: ConnectionRegistry,
  queryId: string,
  ctx: OpenSavedQueryCtx,
): OpenSavedQueryResult {
  return openSavedQueryImpl(tabs, connections, queryId, ctx, openQueryTab, "openSavedQuery");
}

/**
 * Always open a new tab, even if one exists for this saved query.
 *
 * Same focus-switching and fallback logic as `openSavedQuery`; the only
 * difference is that the Postgres path uses `openSavedQueryInNewTab` which
 * bypasses the savedQueryId dedup check.
 */
export function openSavedQueryInNew(
  tabs: TabsApi,
  connections: ConnectionRegistry,
  queryId: string,
  ctx: OpenSavedQueryCtx,
): OpenSavedQueryResult {
  return openSavedQueryImpl(tabs, connections, queryId, ctx, openSavedQueryInNewTab, "openSavedQueryInNew");
}
