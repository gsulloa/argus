/**
 * §20.2 — Open a real mysql-query tab.
 *
 * Replaces the Phase F2 stub. Uses the TabsApi passed from the caller
 * (obtained via `useTabs()`) to open a `MysqlQueryTab`.
 */

import { MYSQL_QUERY_KIND } from "./sql/QueryTab";
import type { QueryParam } from "@/modules/context/types";

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
  /**
   * When opening a tab from a context-folder prefab query, pass its name and
   * declared params so the tab renders a parameter strip and the title uses
   * the prefab's name.
   */
  contextQuery?: {
    /** basename or meta.name; used as the tab title */
    name: string;
    params: QueryParam[];
  };
}

let globalMysqlQueryCounter = 0;

function nextTitle(args: OpenMysqlQueryTabArgs): string {
  if (args.contextQuery) {
    return args.contextQuery.name;
  }
  globalMysqlQueryCounter += 1;
  const base = args.connectionName ? `${args.connectionName} — ` : "";
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
    title: nextTitle(args),
    closable: true,
    payload: {
      connectionId: args.connectionId,
      connectionName: args.connectionName ?? args.connectionId,
      initialSql: args.sql ?? "",
      contextQuery: args.contextQuery,
    },
  });
  return id;
}
