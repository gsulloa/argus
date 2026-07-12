import { contextApi } from "./api";
import { openQueryTab } from "@/modules/postgres/sql";
import { openMysqlQueryTab } from "@/modules/mysql/openMysqlQueryTab";
import { openMssqlQueryTab } from "@/modules/mssql/openMssqlQueryTab";
import { openDynamoQuery } from "@/modules/dynamo/openDynamoQuery";
import { openAthenaQueryTab } from "@/modules/athena/openAthenaQueryTab";
import type { Tab } from "@/platform/shell/tabs/types";
import type { QueryListItem } from "./types";

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

type EngineKind = "postgres" | "mysql" | "mssql" | "dynamo" | "cloudwatch" | "athena";

/**
 * Focus context needed to surface the opened tab. Tabs are scoped to the
 * focused connection's set and only the focused set is rendered, so opening a
 * tab for a non-focused connection would land it in a hidden set (#242).
 * Switching focus first mirrors the saved-query path (openSavedQuery.ts).
 */
export interface OpenContextQueryFocus {
  setFocused: (id: string) => void;
  isOpen: (connectionId: string) => boolean;
}

/**
 * Open a context-folder prefab query in the appropriate engine's editor tab.
 * Dispatches on `engine` to route to Postgres, MySQL, MSSQL, or Dynamo.
 * Fetches the full body via `contextApi.getQuery`.
 */
export async function openContextQuery(
  tabs: TabsApi,
  connectionId: string,
  connectionName: string,
  engine: EngineKind,
  query: QueryListItem,
  focus: OpenContextQueryFocus,
): Promise<void> {
  // Surface the tab in the query's own connection. Without this, opening into a
  // non-focused connection's tab set would show nothing (#242).
  if (focus.isOpen(connectionId)) {
    focus.setFocused(connectionId);
  }

  switch (engine) {
    case "postgres": {
      const doc = await contextApi.getQuery(connectionId, query.path);
      if (!doc) return;
      openQueryTab(tabs, {
        initialConnectionId: connectionId,
        initialConnectionName: connectionName,
        initialSql: doc.body,
        contextQuery: { name: doc.name, params: doc.params, folder: query.folder },
      });
      return;
    }
    case "mysql": {
      const doc = await contextApi.getQuery(connectionId, query.path);
      if (!doc) return;
      openMysqlQueryTab(tabs, {
        connectionId,
        connectionName,
        sql: doc.body,
        contextQuery: { name: doc.name, params: doc.params, folder: query.folder },
      });
      return;
    }
    case "mssql": {
      const doc = await contextApi.getQuery(connectionId, query.path);
      if (!doc) return;
      openMssqlQueryTab(tabs, {
        connectionId,
        connectionName,
        sql: doc.body,
        contextQuery: { name: doc.name, params: doc.params, folder: query.folder },
      });
      return;
    }
    case "dynamo":
      await openDynamoQuery(tabs, connectionId, connectionName, query);
      return;
    case "athena": {
      const doc = await contextApi.getQuery(connectionId, query.path);
      if (!doc) return;
      openAthenaQueryTab(tabs, {
        connectionId,
        connectionName,
        sql: doc.body,
      });
      return;
    }
    case "cloudwatch":
      // CloudWatch logs are immutable — no SQL editor to open a query into.
      // This is a no-op; the caller should not render the row as clickable or
      // surface a tooltip. We return without throwing to avoid crashing.
      return;
    default:
      // Unknown future engine — degrade gracefully.
      return;
  }
}
