/**
 * §20.2 — Open a real mysql-query tab.
 *
 * Replaces the Phase F2 stub. Uses the TabsApi passed from the caller
 * (obtained via `useTabs()`) to open a `MysqlQueryTab`.
 */

import { MYSQL_QUERY_KIND } from "./sql/QueryTab";

/** Minimal tabs surface required to open a MySQL query tab. */
interface TabsMinimal {
  open: (input: {
    id?: string;
    kind: string;
    title: string;
    closable?: boolean;
    payload: unknown;
  }) => string;
}

export interface OpenMysqlQueryTabArgs {
  connectionId: string;
  connectionName?: string;
  sql?: string;
}

let globalMysqlQueryCounter = 0;

function nextTitle(connectionName?: string): string {
  globalMysqlQueryCounter += 1;
  const base = connectionName ? `${connectionName} — ` : "";
  return `${base}Query ${globalMysqlQueryCounter}`;
}

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Open a mysql-query tab. Each call opens a new tab with a unique id
 * (query tabs are not deduplicated — the user may have many open).
 */
export function openMysqlQueryTab(
  tabs: TabsMinimal,
  args: OpenMysqlQueryTabArgs,
): string {
  const id = `mysqlquery:${genId()}`;
  tabs.open({
    id,
    kind: MYSQL_QUERY_KIND,
    title: nextTitle(args.connectionName),
    closable: true,
    payload: {
      connectionId: args.connectionId,
      connectionName: args.connectionName ?? args.connectionId,
      initialSql: args.sql ?? "",
    },
  });
  return id;
}
