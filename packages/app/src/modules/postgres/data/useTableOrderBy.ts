import { useCallback } from "react";
import { useSetting } from "@/platform/settings/useSetting";
import type { OrderBy } from "./types";

function settingsKey(connectionId: string, schema: string, relation: string): string {
  return `pgTableOrder:${connectionId}:${schema}:${relation}`;
}

export interface UseTableOrderByResult {
  /**
   * The persisted order, or `null` when the user has never selected one for
   * this relation (the setting key is absent). The caller derives the default
   * (e.g. PK descending) only in the `null` case; a persisted value — including
   * an explicit empty array `[]` — is honored verbatim and never overwritten.
   */
  persistedOrderBy: OrderBy[] | null;
  isLoaded: boolean;
  setOrderBy(next: OrderBy[]): void;
}

/**
 * Persisted sort scoped to a single `(connectionId, schema, relation)` tuple.
 * Returns `null` when nothing has been persisted (so the caller can distinguish
 * "unset" from a user-chosen empty order).
 */
export function useTableOrderBy(
  connectionId: string,
  schema: string,
  relation: string,
): UseTableOrderByResult {
  const [value, set, isLoaded] = useSetting<OrderBy[] | null>(
    settingsKey(connectionId, schema, relation),
    null,
  );

  const setOrderBy = useCallback(
    (next: OrderBy[]) => {
      set(next);
    },
    [set],
  );

  return { persistedOrderBy: value, isLoaded, setOrderBy };
}
