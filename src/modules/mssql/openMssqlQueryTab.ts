/**
 * Open a mssql-query tab.
 * Supports optional contextQuery payload for prefab queries from a context folder.
 */

import type { QueryParam } from "@/modules/context/types";

/** Tab kind for MS SQL query tabs. */
export const MSSQL_QUERY_KIND = "mssql-query" as const;

/** Minimal tabs surface required to open an MS SQL query tab. */
interface TabsMinimal {
  open: (input: {
    id?: string;
    kind: string;
    title: string;
    closable?: boolean;
    payload: unknown;
  }) => string;
}

export interface OpenMssqlQueryTabArgs {
  connectionId: string;
  connectionName?: string;
  sql?: string;
  /**
   * When opening a tab from a context-folder prefab query, pass its name and
   * declared params so the tab renders a parameter strip.
   */
  contextQuery?: {
    /** basename or meta.name; used as the tab title */
    name: string;
    params: QueryParam[];
  };
}

let globalMssqlQueryCounter = 0;

function nextTitle(connectionName?: string): string {
  globalMssqlQueryCounter += 1;
  const base = connectionName ? `${connectionName} — ` : "";
  return `${base}Query ${globalMssqlQueryCounter}`;
}

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Open an mssql-query tab. Each call opens a new tab with a unique id.
 *
 * - Context queries use `args.contextQuery.name` as the tab title.
 * - Ad-hoc queries get "Query N".
 */
export function openMssqlQueryTab(
  tabs: TabsMinimal,
  args: OpenMssqlQueryTabArgs,
): string {
  const id = `mssqlquery:${genId()}`;
  const title = args.contextQuery ? args.contextQuery.name : nextTitle(args.connectionName);
  tabs.open({
    id,
    kind: MSSQL_QUERY_KIND,
    title,
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
