/**
 * Open a mssql-query tab.
 * The actual tab kind constant is defined in sql/QueryTab.tsx (Phase F3).
 * For F1 we define a stub constant and opener so palette commands can compile.
 */

/** Tab kind for MS SQL query tabs — matches the backend constant defined in Phase F3. */
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
 */
export function openMssqlQueryTab(
  tabs: TabsMinimal,
  args: OpenMssqlQueryTabArgs,
): string {
  const id = `mssqlquery:${genId()}`;
  tabs.open({
    id,
    kind: MSSQL_QUERY_KIND,
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
