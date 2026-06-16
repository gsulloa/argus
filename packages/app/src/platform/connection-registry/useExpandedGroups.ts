import { useCallback, useEffect, useState } from "react";

const KEY_PREFIX = "connection-groups.expanded.";

function readExpanded(groupId: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + groupId);
    if (raw === null) return true;
    return raw !== "0";
  } catch {
    return true;
  }
}

function writeExpanded(groupId: string, expanded: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY_PREFIX + groupId, expanded ? "1" : "0");
  } catch {
    // localStorage unavailable / quota — ignore.
  }
}

export function useExpandedGroups(groupIds: readonly string[]) {
  const [state, setState] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {};
    for (const id of groupIds) out[id] = readExpanded(id);
    return out;
  });

  useEffect(() => {
    setState((prev) => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const id of groupIds) {
        if (id in prev) {
          next[id] = prev[id] ?? true;
        } else {
          next[id] = readExpanded(id);
          changed = true;
        }
      }
      for (const id of Object.keys(prev)) {
        if (!(id in next)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [groupIds]);

  const isExpanded = useCallback((id: string) => state[id] !== false, [state]);

  const toggle = useCallback((id: string) => {
    setState((prev) => {
      const next = !(prev[id] !== false);
      writeExpanded(id, next);
      return { ...prev, [id]: next };
    });
  }, []);

  const setExpanded = useCallback((id: string, expanded: boolean) => {
    setState((prev) => {
      writeExpanded(id, expanded);
      return { ...prev, [id]: expanded };
    });
  }, []);

  return { isExpanded, toggle, setExpanded };
}
