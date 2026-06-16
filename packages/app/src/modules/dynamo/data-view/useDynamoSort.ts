/**
 * useDynamoSort — persists TanStack sorting state per (connectionId, tableName).
 *
 * Key: `dynamoSort:<connectionId>:<tableName>`
 * Shape: TanStack's SortingState = Array<{ id: string; desc: boolean }>
 * Default: [] (no sort)
 */

import type { OnChangeFn, SortingState } from "@tanstack/react-table";
import { useSetting } from "@/platform/settings/useSetting";

export function useDynamoSort(
  connectionId: string,
  tableName: string,
): { sorting: SortingState; setSorting: OnChangeFn<SortingState> } {
  const key = `dynamoSort:${connectionId}:${tableName}`;
  const [sorting, setSetting] = useSetting<SortingState>(key, []);

  // setSetting from useSetting already accepts both a value and an updater fn
  // (it calls setValue internally which handles the updater pattern).
  // We cast here to satisfy OnChangeFn<SortingState>.
  const setSorting: OnChangeFn<SortingState> = (updater) => {
    setSetting(updater as SortingState | ((prev: SortingState) => SortingState));
  };

  return { sorting, setSorting };
}
