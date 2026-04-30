import { useCallback } from "react";
import { useSetting } from "@/platform/settings/useSetting";
import { EMPTY_FILTER_MODEL, type FilterModel } from "./types";

interface PersistedFilter {
  draft: FilterModel;
  applied: FilterModel;
}

const DEFAULT: PersistedFilter = {
  draft: EMPTY_FILTER_MODEL,
  applied: EMPTY_FILTER_MODEL,
};

function settingsKey(connectionId: string, schema: string, relation: string): string {
  return `pgTableFilter:${connectionId}:${schema}:${relation}`;
}

export interface UseTableFilterResult {
  draft: FilterModel;
  applied: FilterModel;
  isLoaded: boolean;
  setDraft(next: FilterModel): void;
  setApplied(next: FilterModel): void;
  reset(): void;
}

/**
 * Persisted filter (draft + applied) scoped to a single
 * `(connectionId, schema, relation)` tuple. Both halves are stored in one
 * record so a partial-write can never leave them incoherent.
 *
 * `isLoaded` flips `true` once the disk read has resolved (or immediately
 * outside Tauri / when the value is already in the in-memory cache). Callers
 * should gate the first-page fetch on this flag to avoid issuing a spurious
 * `applied = empty` query before the persisted filter lands.
 */
export function useTableFilter(
  connectionId: string,
  schema: string,
  relation: string,
): UseTableFilterResult {
  const [value, set, isLoaded] = useSetting<PersistedFilter>(
    settingsKey(connectionId, schema, relation),
    DEFAULT,
  );

  const setDraft = useCallback(
    (next: FilterModel) => {
      set((prev) => ({ ...prev, draft: next }));
    },
    [set],
  );

  const setApplied = useCallback(
    (next: FilterModel) => {
      set((prev) => ({ ...prev, applied: next }));
    },
    [set],
  );

  const reset = useCallback(() => {
    set(DEFAULT);
  }, [set]);

  return {
    draft: value.draft,
    applied: value.applied,
    isLoaded,
    setDraft,
    setApplied,
    reset,
  };
}
