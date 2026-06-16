import { useCallback } from "react";
import { useSetting } from "@/platform/settings/useSetting";

const DEFAULT_COMBINATOR: "AND" | "OR" = "AND";

function settingsKey(connectionId: string, schema: string, relation: string): string {
  return `pgFilterRootCombinator:${connectionId}:${schema}:${relation}`;
}

/**
 * Persisted root combinator (AND / OR) for the filter bar, scoped to a single
 * (connection, schema, relation) tuple. Defaults to `"AND"`. Persisted across
 * app restarts via the same SQLite-backed settings store used by `usePageSize`.
 */
export function useFilterRootCombinator(
  connectionId: string,
  schema: string,
  relation: string,
): ["AND" | "OR", (next: "AND" | "OR") => void] {
  const [raw, set] = useSetting<"AND" | "OR">(
    settingsKey(connectionId, schema, relation),
    DEFAULT_COMBINATOR,
  );

  // Guard against persisted garbage: only accept known values.
  const value: "AND" | "OR" = raw === "AND" || raw === "OR" ? raw : DEFAULT_COMBINATOR;

  const setCombinator = useCallback(
    (next: "AND" | "OR") => {
      set(next);
    },
    [set],
  );

  return [value, setCombinator];
}
