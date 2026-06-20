/**
 * Forced reload of one DynamoDB connection's table tree. The table cache lives
 * in `DynamoTablesCacheProvider` (React context), so an out-of-tree caller
 * (the global `Cmd+R` / `Ctrl+R` accelerator) signals it via a window event;
 * the provider listens and drops + re-lists the connection.
 */

export const DYNAMO_TABLES_REFRESH_EVENT = "dynamo:tables-refresh";

export function refreshConnection(connectionId: string): void {
  window.dispatchEvent(
    new CustomEvent(DYNAMO_TABLES_REFRESH_EVENT, { detail: connectionId }),
  );
}
