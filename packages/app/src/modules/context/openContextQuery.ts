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
      await openDynamoQuery(tabs, connectionId, connectionName, query);
      return;
    case "athena": {
      const doc = await contextApi.getQuery(connectionId, query.name);
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
