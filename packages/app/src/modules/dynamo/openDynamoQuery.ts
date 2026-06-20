import { contextApi } from "@/modules/context/api";
import { substituteDynamoParams, type ParamValue } from "@/modules/context/components/substituteParams";
import type { QueryListItem } from "@/modules/context/types";
import { openDynamoPartiQLTab } from "./sql";

interface TabsMinimal {
  open: (input: {
    id?: string;
    kind: string;
    title: string;
    closable?: boolean;
    payload: unknown;
  }) => string;
}

/**
 * Opens a Dynamo context query in a PartiQL editor tab pre-filled with the
 * substituted query body.
 *
 *   1. Fetches the query doc from the context folder.
 *   2. Substitutes `$name` parameters with their declared default values
 *      (empty string when no default is provided) via `substituteDynamoParams`.
 *   3. Opens a PartiQL editor tab pre-filled with the substituted body.
 */
export async function openDynamoQuery(
  tabs: TabsMinimal,
  connectionId: string,
  connectionName: string,
  query: QueryListItem,
): Promise<void> {
  const doc = await contextApi.getQuery(connectionId, query.name);
  if (!doc) return;

  // Build param values from declared defaults (fall back to empty string).
  const values: ParamValue[] = doc.params.map((p) => ({
    name: p.name,
    value: p.default != null ? String(p.default) : "",
  }));

  const substituted = substituteDynamoParams(doc.body, values);

  openDynamoPartiQLTab(tabs, connectionId, connectionName, substituted);
}
