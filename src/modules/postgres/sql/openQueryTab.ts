import { POSTGRES_QUERY_KIND, type PostgresQueryPayload } from "./QueryTab";

interface TabsApi {
  open: (input: {
    id?: string;
    kind: string;
    title: string;
    closable?: boolean;
    payload: unknown;
  }) => string;
}

const counters = new Map<string, number>();

function nextTitle(connectionId: string): string {
  const cur = counters.get(connectionId) ?? 0;
  const next = cur + 1;
  counters.set(connectionId, next);
  return `Query ${next}`;
}

function genId(): string {
  // Browser/desktop have crypto.randomUUID; fall back to a Math.random tag.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Open a fresh `postgres-query` tab for the given connection. Always creates
 * a new tab (never focuses an existing one) so the user can have multiple
 * queries against the same connection.
 */
export function openQueryTab(
  tabs: TabsApi,
  args: { connectionId: string; connectionName: string; sql?: string },
): string {
  const payload: PostgresQueryPayload = {
    connectionId: args.connectionId,
    connectionName: args.connectionName,
    sql: args.sql ?? "",
  };
  return tabs.open({
    id: `pgquery:${args.connectionId}:${genId()}`,
    kind: POSTGRES_QUERY_KIND,
    title: nextTitle(args.connectionId),
    payload,
  });
}
