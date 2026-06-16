import { contextApi } from "./api";
import { openQueryTab } from "@/modules/postgres/sql";
import { openMysqlQueryTab } from "@/modules/mysql/openMysqlQueryTab";
import { openMssqlQueryTab } from "@/modules/mssql/openMssqlQueryTab";
import { openDynamoQuery } from "@/modules/dynamo/openDynamoQuery";
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

type EngineKind = "postgres" | "mysql" | "mssql" | "dynamo" | "cloudwatch";

/**
 * Open a context-folder prefab query in the appropriate engine's editor tab.
 * Dispatches on `engine` to route to Postgres, MySQL, MSSQL, or Dynamo
 * (clipboard fallback). Fetches the full body via `contextApi.getQuery`.
 */
export async function openContextQuery(
  tabs: TabsApi,
  connectionId: string,
  connectionName: string,
  engine: EngineKind,
  query: QueryListItem,
  options?: { onCopied?: (queryName: string) => void },
): Promise<void> {
  switch (engine) {
    case "postgres": {
      const doc = await contextApi.getQuery(connectionId, query.name);
      if (!doc) return;
      openQueryTab(tabs, {
        initialConnectionId: connectionId,
        initialConnectionName: connectionName,
        initialSql: doc.body,
        contextQuery: { name: doc.name, params: doc.params },
      });
      return;
    }
    case "mysql": {
      const doc = await contextApi.getQuery(connectionId, query.name);
      if (!doc) return;
      openMysqlQueryTab(tabs, {
        connectionId,
        connectionName,
        sql: doc.body,
        contextQuery: { name: doc.name, params: doc.params },
      });
      return;
    }
    case "mssql": {
      const doc = await contextApi.getQuery(connectionId, query.name);
      if (!doc) return;
      openMssqlQueryTab(tabs, {
        connectionId,
        connectionName,
        sql: doc.body,
        contextQuery: { name: doc.name, params: doc.params },
      });
      return;
    }
    case "dynamo":
      // No native PartiQL editor in v1 — clipboard fallback (§11.3).
      await openDynamoQuery(tabs, connectionId, connectionName, query, options?.onCopied);
      return;
    default:
      throw new Error(`Unsupported engine for context queries: ${engine as string}`);
  }
}
