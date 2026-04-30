import { useCallback, useState } from "react";
import type { TableEntry } from "./useTableIndex";

const STORAGE_KEY = "argus.recentTables.v1";
const CAP = 10;

function isTableEntry(v: unknown): v is TableEntry {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.connectionId === "string" &&
    typeof o.connectionName === "string" &&
    typeof o.schema === "string" &&
    typeof o.name === "string" &&
    (o.kind === "table" || o.kind === "view" || o.kind === "materialized-view")
  );
}

function readStorage(): TableEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTableEntry).slice(0, CAP);
  } catch {
    return [];
  }
}

function writeStorage(entries: TableEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota or unavailable storage; stay in-memory only.
  }
}

export interface UseRecentTables {
  recents: TableEntry[];
  push: (entry: TableEntry) => void;
}

/**
 * Persisted MRU list of relations the user has jumped to via the table
 * quick-switcher. Capped at 10. Sidebar clicks do NOT touch this — only
 * `TablePalette.onSelect` calls `push`.
 */
export function useRecentTables(): UseRecentTables {
  const [recents, setRecents] = useState<TableEntry[]>(() => readStorage());

  const push = useCallback((entry: TableEntry) => {
    setRecents((prev) => {
      const filtered = prev.filter(
        (e) =>
          !(
            e.connectionId === entry.connectionId &&
            e.schema === entry.schema &&
            e.name === entry.name
          ),
      );
      const next = [entry, ...filtered].slice(0, CAP);
      writeStorage(next);
      return next;
    });
  }, []);

  return { recents, push };
}
