/**
 * openTableTab — shared helper for opening or focusing a dynamo-data-view tab
 * from any call site (leaf activation, context menu, palette command).
 *
 * The `tabs.open()` call deduplicates by the stable id
 * `dynamotbl:<connectionId>:<tableName>`, so calling it when the tab is already
 * open will just focus the existing tab.
 *
 * Delegates to `openDataViewTab` from the data-view module so there is exactly
 * one place that builds the tab open options (kind, id, payload shape).
 */

import type { useTabs } from "@/platform/shell/tabs";
import type { TableDescription } from "./types";
import { openDataViewTab } from "@/modules/dynamo/data-view/DataViewTab";

export function openTableTab(
  tabs: ReturnType<typeof useTabs>,
  opts: {
    connectionId: string;
    connectionName: string;
    tableName: string;
    describe: TableDescription | null;
  },
): string {
  return openDataViewTab(tabs, opts);
}
