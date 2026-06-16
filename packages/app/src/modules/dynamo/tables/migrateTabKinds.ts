/**
 * migrateTabKinds — session-state migration for dynamo tab kinds.
 *
 * On tab-store load, any persisted tab record with kind
 * "dynamo-table-placeholder" is rewritten to "dynamo-data-view" while
 * preserving its payload's `describe` field intact.
 *
 * This is a one-way migration: "dynamo-table-placeholder" no longer exists in
 * the tab-kind registry; tabs of the old kind would not render. By migrating
 * them on load, users with an open placeholder tab at upgrade time continue
 * to see a working data view tab.
 *
 * The function is pure (no side effects) so it can be unit-tested directly.
 */

import { DYNAMO_DATA_VIEW_KIND } from "@/modules/dynamo/data-view/DataViewTab";
import type { Tab } from "@/platform/shell/tabs/types";

export const DYNAMO_TABLE_PLACEHOLDER_KIND = "dynamo-table-placeholder";

/**
 * Rewrite any placeholder tab records to data-view kind in-place (returns a
 * new array; does not mutate the input).
 */
export function migratePlaceholderTabs(tabs: Tab[]): Tab[] {
  let changed = false;
  const next = tabs.map((tab) => {
    if (tab.kind !== DYNAMO_TABLE_PLACEHOLDER_KIND) return tab;
    changed = true;
    return {
      ...tab,
      kind: DYNAMO_DATA_VIEW_KIND,
      // payload shape is compatible: both kinds use
      // { connectionId, connectionName, tableName, describe }
    };
  });
  return changed ? next : tabs;
}
