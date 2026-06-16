import { useCallback } from "react";
import { useSetting } from "@/platform/settings/useSetting";
import type { OrderBy } from "./types";

const DEFAULT: OrderBy[] = [];

function settingsKey(connectionId: string, schema: string, relation: string): string {
  return `pgTableOrder:${connectionId}:${schema}:${relation}`;
}

export interface UseTableOrderByResult {
  orderBy: OrderBy[];
  isLoaded: boolean;
  setOrderBy(next: OrderBy[]): void;
}

/**
 * Persisted sort scoped to a single `(connectionId, schema, relation)` tuple.
 * Default is the empty array (the relation's natural row order).
 */
export function useTableOrderBy(
  connectionId: string,
  schema: string,
  relation: string,
): UseTableOrderByResult {
  const [value, set, isLoaded] = useSetting<OrderBy[]>(
    settingsKey(connectionId, schema, relation),
    DEFAULT,
  );

  const setOrderBy = useCallback(
    (next: OrderBy[]) => {
      set(next);
    },
    [set],
  );

  return { orderBy: value, isLoaded, setOrderBy };
}
