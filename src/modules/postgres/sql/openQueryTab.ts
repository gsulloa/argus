import { POSTGRES_QUERY_KIND, type PostgresQueryPayload } from "./QueryTab";
import type { Tab } from "@/platform/shell/tabs/types";
import { savedQueriesStore } from "@/modules/saved-queries/store";

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

/**
 * App-global counter for naming ad-hoc query tabs ("Query 1", "Query 2", …).
 * Resets on app launch (in-memory only, not persisted). No longer per-connection
 * since tabs are now connection-agnostic.
 */
let globalQueryCounter = 0;

function nextTitle(): string {
  globalQueryCounter += 1;
  return `Query ${globalQueryCounter}`;
}

function genId(): string {
  // Browser/desktop have crypto.randomUUID; fall back to a Math.random tag.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface OpenQueryTabArgs {
  /** Pre-select this connection in the toolbar selector on tab open. */
  initialConnectionId?: string;
  initialConnectionName?: string;
  /** Pre-populate the editor with this SQL. */
  initialSql?: string;
  /**
   * If set, this tab is bound to a saved query.
   * `openQueryTab` will focus an existing open tab with the same
   * `savedQueryId` instead of creating a new one.
   */
  savedQueryId?: string;
}

/**
 * Open a `postgres-query` tab.
 *
 * - When `savedQueryId` is provided: finds an already-open tab with the same
 *   `savedQueryId` in its payload and focuses it (no new tab created).
 * - Otherwise (including when no `savedQueryId` is given): always creates a
 *   new tab.
 */
export function openQueryTab(tabs: TabsApi, args: OpenQueryTabArgs): string {
  // 5.4: If a savedQueryId is given, reuse the existing open tab.
  if (args.savedQueryId) {
    const existing = tabs.tabs.find(
      (t) =>
        t.kind === POSTGRES_QUERY_KIND &&
        (t.payload as PostgresQueryPayload).savedQueryId === args.savedQueryId,
    );
    if (existing) {
      tabs.activate(existing.id);
      return existing.id;
    }
  }

  const payload: PostgresQueryPayload = {
    initialConnectionId: args.initialConnectionId,
    initialConnectionName: args.initialConnectionName,
    initialSql: args.initialSql ?? "",
    savedQueryId: args.savedQueryId,
  };

  // Saved queries use the saved name as title; ad-hoc tabs get "Query N".
  // Reads from the store synchronously — the store should be loaded by the
  // time the user can interact with the panel. Falls back to "Loading…" if the
  // store hasn't loaded yet (the hydration effect in useQueryTabState will
  // update the tab title once data arrives).
  let title: string;
  if (args.savedQueryId) {
    const snapshot = savedQueriesStore.getSnapshot();
    const savedQ = snapshot.queries.find((q) => q.id === args.savedQueryId);
    title = savedQ?.name ?? "Loading…";
  } else {
    title = nextTitle();
  }

  return tabs.open({
    id: `pgquery:${genId()}`,
    kind: POSTGRES_QUERY_KIND,
    title,
    payload,
  });
}

/**
 * 5.5 — Always creates a new tab, even if a tab with the same `savedQueryId`
 * is already open. Useful for "Open in new tab" context-menu action.
 */
export function openSavedQueryInNewTab(tabs: TabsApi, args: OpenQueryTabArgs): string {
  const payload: PostgresQueryPayload = {
    initialConnectionId: args.initialConnectionId,
    initialConnectionName: args.initialConnectionName,
    initialSql: args.initialSql ?? "",
    savedQueryId: args.savedQueryId,
  };

  // Use the saved query name if available; fall back to "Query N".
  let title: string;
  if (args.savedQueryId) {
    const snapshot = savedQueriesStore.getSnapshot();
    const savedQ = snapshot.queries.find((q) => q.id === args.savedQueryId);
    title = savedQ?.name ?? nextTitle();
  } else {
    title = nextTitle();
  }

  return tabs.open({
    id: `pgquery:${genId()}`,
    kind: POSTGRES_QUERY_KIND,
    title,
    payload,
  });
}
