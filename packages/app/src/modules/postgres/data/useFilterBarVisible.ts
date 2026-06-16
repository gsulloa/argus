import { useCallback } from "react";
import { useSetting } from "@/platform/settings/useSetting";

const DEFAULT_VISIBLE = false;

function settingsKey(connectionId: string, schema: string, relation: string): string {
  return `pgFilterBarVisible:${connectionId}:${schema}:${relation}`;
}

/**
 * Persisted filter-bar visibility scoped to a single (connection, schema,
 * relation) tuple. Defaults to `false` (hidden). Persisted across app
 * restarts via the same SQLite-backed settings store used by `usePageSize`.
 */
export function useFilterBarVisible(
  connectionId: string,
  schema: string,
  relation: string,
): [boolean, (next: boolean) => void] {
  const [value, set] = useSetting<boolean>(
    settingsKey(connectionId, schema, relation),
    DEFAULT_VISIBLE,
  );

  const setVisible = useCallback(
    (next: boolean) => {
      set(next);
    },
    [set],
  );

  return [value, setVisible];
}
