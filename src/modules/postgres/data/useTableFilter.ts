import { useCallback, useMemo } from "react";
import { useSetting } from "@/platform/settings/useSetting";
import { EMPTY_FILTER_MODEL, type FilterModel } from "./types";

export interface PersistedFilter {
  draft: FilterModel;
  applied: FilterModel;
}

const DEFAULT: PersistedFilter = {
  draft: EMPTY_FILTER_MODEL,
  applied: EMPTY_FILTER_MODEL,
}

/**
 * Normalize a `PersistedFilter` read from storage. Coerces a missing
 * `combinator` field on each tree to `"AND"` for backward compatibility
 * with records written before this field existed.
 *
 * Exported for unit testing only; prefer `useTableFilter` in production code.
 */
export function normalizePersistedFilter(value: PersistedFilter): PersistedFilter {
  const normTree = (model: FilterModel): FilterModel => ({
    ...model,
    tree: {
      ...model.tree,
      combinator: model.tree.combinator ?? "AND",
    },
  });
  return {
    draft: normTree(value.draft),
    applied: normTree(value.applied),
  };
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
  const [raw, set, isLoaded] = useSetting<PersistedFilter>(
    settingsKey(connectionId, schema, relation),
    DEFAULT,
  );

  // Normalize on every read: coerce missing `combinator` to "AND" so that
  // records persisted before this field existed behave correctly. Memoize on
  // `raw` so `draft` / `applied` keep stable references across renders —
  // consumers' useEffects depend on these and would otherwise refire every
  // render, clearing row selection and refetching counts spuriously.
  const value = useMemo(() => normalizePersistedFilter(raw), [raw]);

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
