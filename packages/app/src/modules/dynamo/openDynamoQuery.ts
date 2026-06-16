// TODO: When a native Dynamo PartiQL editor tab exists, replace the clipboard
// fallback below with an `openDynamoPartiQLTab(tabs, ...)` call that wires the
// body + ParamStrip into the editor (§11.2 / D7 routing path).

import { contextApi } from "@/modules/context/api";
import { substituteDynamoParams, type ParamValue } from "@/modules/context/components/substituteParams";
import type { QueryListItem } from "@/modules/context/types";

/**
 * Opens a Dynamo context query for the given `connectionId`.
 *
 * Because no native PartiQL editor tab exists in v1, this function:
 *   1. Fetches the query doc from the context folder.
 *   2. Substitutes `$name` parameters with their declared default values
 *      (empty string when no default is provided) via `substituteDynamoParams`.
 *   3. Writes the substituted query to the clipboard.
 *   4. Calls `onCopied` (if provided) so the caller can show a toast.
 *
 * The `tabs` parameter is accepted for API-compatibility with the other engines'
 * `openXxxQueryTab` helpers; it is unused until a real editor exists.
 */
export async function openDynamoQuery(
  _tabs: unknown,
  connectionId: string,
  _connectionName: string,
  query: QueryListItem,
  onCopied?: (queryName: string) => void,
): Promise<void> {
  const doc = await contextApi.getQuery(connectionId, query.name);
  if (!doc) return;

  // Build param values from declared defaults (fall back to empty string).
  const values: ParamValue[] = doc.params.map((p) => ({
    name: p.name,
    value: p.default != null ? String(p.default) : "",
  }));

  const substituted = substituteDynamoParams(doc.body, values);

  await navigator.clipboard.writeText(substituted);
  onCopied?.(query.name);
}
