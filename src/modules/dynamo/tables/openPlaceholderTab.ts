/**
 * openPlaceholderTab — shared helper for opening or focusing a
 * dynamo-table-placeholder tab from any call site (leaf activation,
 * context menu, palette command).
 *
 * The `tabs.open()` call deduplicates by the stable id `dynamotbl:<connectionId>:<tableName>`,
 * so calling it when the tab is already open will just focus the existing tab.
 */

import type { useTabs } from "@/platform/shell/tabs";
import { DYNAMO_TABLE_PLACEHOLDER_KIND } from "./PlaceholderTab";
import type { DynamoTablePlaceholderPayload } from "./PlaceholderTab";
import type { TableDescription } from "./types";

export function openPlaceholderTab(
  tabs: ReturnType<typeof useTabs>,
  opts: {
    connectionId: string;
    connectionName: string;
    tableName: string;
    describe: TableDescription | null;
  },
): string {
  const { connectionId, connectionName, tableName, describe } = opts;

  const payload: DynamoTablePlaceholderPayload = {
    connectionId,
    connectionName,
    tableName,
    describe,
  };

  return tabs.open({
    id: `dynamotbl:${connectionId}:${tableName}`,
    kind: DYNAMO_TABLE_PLACEHOLDER_KIND,
    title: tableName,
    payload,
    closable: true,
  });
}
