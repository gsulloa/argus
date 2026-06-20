/**
 * Open a dynamo-query (PartiQL editor) tab.
 *
 * Each call opens a new tab with a unique id — query tabs are not deduplicated.
 * This helper is called by group-4 wiring (commands.ts, table-leaf context menu,
 * openDynamoQuery.ts) so it lives here in the sql/ subfolder.
 */

import { DYNAMO_QUERY_KIND } from "./QueryTab";

interface TabsMinimal {
  open: (input: {
    id?: string;
    kind: string;
    title: string;
    closable?: boolean;
    payload: unknown;
  }) => string;
}

let globalQueryCounter = 0;

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Open a new DynamoDB PartiQL editor tab.
 *
 * @param tabs         — the tabs store (must have an `open` method)
 * @param connectionId — the DynamoDB connection to run against
 * @param connectionName — human-readable connection label for the tab title
 * @param initialPartiql — optional pre-filled PartiQL body
 * @returns the new tab id
 */
export function openDynamoPartiQLTab(
  tabs: TabsMinimal,
  connectionId: string,
  connectionName: string,
  initialPartiql?: string,
): string {
  globalQueryCounter += 1;
  const id = `dynamoquery:${genId()}`;
  const base = connectionName ? `${connectionName} — ` : "";
  const title = `${base}PartiQL ${globalQueryCounter}`;

  tabs.open({
    id,
    kind: DYNAMO_QUERY_KIND,
    title,
    closable: true,
    payload: {
      connectionId,
      connectionName,
      initialPartiql: initialPartiql ?? "",
    },
  });
  return id;
}
