/**
 * Open an athena-query tab.
 *
 * Each call opens a new tab with a unique id (query tabs are not
 * deduplicated — the user may have many open).
 */

import { ATHENA_QUERY_KIND, type AthenaQueryOrigin } from "./sql/QueryTab";

interface TabsMinimal {
  open: (input: {
    id?: string;
    kind: string;
    title: string;
    closable?: boolean;
    payload: unknown;
  }) => string;
}

export interface OpenAthenaQueryTabArgs {
  connectionId: string;
  connectionName?: string;
  sql?: string;
  /**
   * When set, the opened tab is linked to an existing NamedQuery.
   * The toolbar will show "Update '<name>'" instead of "Save as Named Query".
   */
  origin?: AthenaQueryOrigin;
  /**
   * Pre-fills the "Save as Named Query" modal's database field when the tab
   * was opened from a table/view leaf in a known database context.
   */
  defaultDatabase?: string;
}

let globalAthenaQueryCounter = 0;

function nextTitle(args: OpenAthenaQueryTabArgs): string {
  globalAthenaQueryCounter += 1;
  // If the tab is linked to a named query, use the query name as the title.
  if (args.origin?.name) {
    return args.origin.name;
  }
  const base = args.connectionName ? `${args.connectionName} — ` : "";
  return `${base}Query ${globalAthenaQueryCounter}`;
}

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function openAthenaQueryTab(
  tabs: TabsMinimal,
  args: OpenAthenaQueryTabArgs,
): string {
  const id = `athenaquery:${genId()}`;
  tabs.open({
    id,
    kind: ATHENA_QUERY_KIND,
    title: nextTitle(args),
    closable: true,
    payload: {
      connectionId: args.connectionId,
      connectionName: args.connectionName ?? args.connectionId,
      initialSql: args.sql ?? "",
      // Optional fields — only included when provided so payload remains
      // backward-compatible with persisted tabs that lack these keys.
      ...(args.origin !== undefined ? { origin: args.origin } : {}),
      ...(args.defaultDatabase !== undefined ? { defaultDatabase: args.defaultDatabase } : {}),
    },
  });
  return id;
}
