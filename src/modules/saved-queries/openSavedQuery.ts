/**
 * 9.1 — Open a saved query in an existing or new tab.
 *
 * Reads the query from the saved-queries store, checks whether a tab already
 * exists for it (by savedQueryId), and either focuses the existing tab or
 * opens a new one via `openQueryTab`.
 */

import { openQueryTab, openSavedQueryInNewTab, type OpenQueryTabArgs } from "@/modules/postgres/sql/openQueryTab";
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

interface ConnectionRegistry {
  items: Array<{ id: string; name: string }>;
}

function buildArgs(queryId: string, connections: Array<{ id: string; name: string }>): OpenQueryTabArgs | null {
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
 * 9.4: If `last_connection_id` references a connection not in the registry,
 * `initialConnectionId` will be undefined — the selector opens empty.
 */
export function openSavedQuery(
  tabs: TabsApi,
  connections: ConnectionRegistry,
  queryId: string,
): void {
  const args = buildArgs(queryId, connections.items);
  if (!args) {
    console.warn(`[saved-queries] openSavedQuery: query "${queryId}" not found in store.`);
    return;
  }
  openQueryTab(tabs, args);
}

/**
 * 9.3 — Always open a new tab, even if one exists for this saved query.
 */
export function openSavedQueryInNew(
  tabs: TabsApi,
  connections: ConnectionRegistry,
  queryId: string,
): void {
  const args = buildArgs(queryId, connections.items);
  if (!args) {
    console.warn(`[saved-queries] openSavedQueryInNew: query "${queryId}" not found in store.`);
    return;
  }
  openSavedQueryInNewTab(tabs, args);
}
