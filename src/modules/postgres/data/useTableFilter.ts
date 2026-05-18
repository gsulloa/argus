import { useCallback, useMemo } from "react";
import { useSetting } from "@/platform/settings/useSetting";
import { EMPTY_FILTER_MODEL, type FilterModel } from "./types";
import { migrateLegacyFilterModel } from "./filter-bar/migrateLegacyFilterModel";

export interface PersistedFilter {
  draft: FilterModel;
  applied: FilterModel;
}

const DEFAULT: PersistedFilter = {
  draft: EMPTY_FILTER_MODEL,
  applied: EMPTY_FILTER_MODEL,
}

/**
 * Normalize a `PersistedFilter` read from storage. Pipes each half through
 * `migrateLegacyFilterModel` to handle legacy shapes (mode/tree/raw,
 * or_group children) gracefully — they reset to EMPTY_FILTER_MODEL.
 *
 * Exported for unit testing only; prefer `useTableFilter` in production code.
 */
export function normalizePersistedFilter(raw: unknown): PersistedFilter {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT;
  }
  const obj = raw as Record<string, unknown>;
  return {
    draft: migrateLegacyFilterModel(obj["draft"]),
    applied: migrateLegacyFilterModel(obj["applied"]),
  };
}

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
  // Use `unknown` generic so the raw value from disk flows through migration
  // without a premature cast. At runtime the JSON may be a legacy shape.
  const [raw, set, isLoaded] = useSetting<unknown>(
    settingsKey(connectionId, schema, relation),
    DEFAULT,
  );

  // Normalize on every read — migrates legacy shapes (mode/tree/raw) to empty
  // and coerces any missing fields. Memoize on `raw` so `draft` / `applied`
  // keep stable references across renders — consumers' useEffects depend on
  // these and would otherwise refire every render, clearing row selection and
  // refetching counts spuriously.
  const value = useMemo(() => normalizePersistedFilter(raw), [raw]);

  const setDraft = useCallback(
    (next: FilterModel) => {
      set((prev: unknown) => {
        const p = normalizePersistedFilter(prev);
        return { ...p, draft: next };
      });
    },
    [set],
  );

  const setApplied = useCallback(
    (next: FilterModel) => {
      set((prev: unknown) => {
        const p = normalizePersistedFilter(prev);
        return { ...p, applied: next };
      });
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
