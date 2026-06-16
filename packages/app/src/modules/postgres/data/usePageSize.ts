import { useCallback } from "react";
import { useSetting } from "@/platform/settings/useSetting";

const DEFAULT_PAGE_SIZE = 200;
const ALLOWED = new Set([100, 200, 500, 1000]);

function settingsKey(connectionId: string, schema: string, relation: string): string {
  return `pgTableLimit:${connectionId}:${schema}:${relation}`;
}

export interface UsePageSizeResult {
  pageSize: number;
  setPageSize(next: number): void;
  options: number[];
}

/**
 * Persisted page size scoped to a single (connection, schema, relation) tuple.
 * Two connections inspecting the same `<schema>.<relation>` keep independent
 * preferences, per spec.
 */
export function usePageSize(
  connectionId: string,
  schema: string,
  relation: string,
): UsePageSizeResult {
  const [value, set] = useSetting<number>(
    settingsKey(connectionId, schema, relation),
    DEFAULT_PAGE_SIZE,
  );

  const setPageSize = useCallback(
    (next: number) => {
      if (!ALLOWED.has(next)) return;
      set(next);
    },
    [set],
  );

  return {
    pageSize: ALLOWED.has(value) ? value : DEFAULT_PAGE_SIZE,
    setPageSize,
    options: [100, 200, 500, 1000],
  };
}
