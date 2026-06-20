import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Tab } from "./types";
import { FocusedConnectionCtxRef } from "@/platform/shell/FocusedConnectionContext";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OpenInput = Omit<Tab, "id" | "closable"> & {
  id?: string;
  closable?: boolean;
};

interface ConnectionTabSet {
  tabs: Tab[];
  activeTabId: string | null;
}

interface TabsCtx {
  /** Tabs of the currently-focused connection (empty when no connection is focused). */
  tabs: Tab[];
  /** Active tab id of the currently-focused connection (null when none). */
  activeTabId: string | null;
  open: (input: OpenInput) => string;
  close: (id: string) => void;
  activate: (id: string) => void;
  move: (fromIndex: number, toIndex: number) => void;
  cycle: (direction: 1 | -1) => void;
  /** Update the visible title of a tab by id. No-op if the tab does not exist. */
  setTabTitle: (id: string, title: string) => void;
  /** Mark or unmark a tab as dirty. Drives the ● indicator in the tab strip. */
  setTabDirty: (id: string, dirty: boolean) => void;
  /**
   * Read-only snapshot of ALL connection sets, keyed by connectionId.
   * Used by TabContent to keep every ever-activated tab mounted.
   * Not part of the consumer API — internal use only.
   */
  _allSets: ReadonlyMap<string, ConnectionTabSet>;
}

const Ctx = createContext<TabsCtx | null>(null);

let counter = 0;
function nextId(prefix: string) {
  counter += 1;
  return `${prefix}-${counter}-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// Helper: extract connectionId from a tab payload (best-effort).
// ---------------------------------------------------------------------------

function extractConnectionId(input: OpenInput): string | null {
  const payload = input.payload as { connectionId?: unknown } | null | undefined;
  if (
    payload !== null &&
    payload !== undefined &&
    typeof payload === "object" &&
    typeof payload.connectionId === "string"
  ) {
    return payload.connectionId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: find which connection set contains a given tab id.
// ---------------------------------------------------------------------------

function findSetKey(
  allSets: Map<string, ConnectionTabSet>,
  tabId: string,
): string | null {
  for (const [key, set] of allSets) {
    if (set.tabs.some((t) => t.id === tabId)) return key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function TabsProvider({ children }: { children: ReactNode }) {
  // Each entry: connectionId → { tabs, activeTabId }.
  // The map is treated as immutable: always produce a new Map on changes.
  const [allSets, setAllSets] = useState<Map<string, ConnectionTabSet>>(
    () => new Map(),
  );

  // Read the focused connection id — provided by FocusedConnectionProvider which
  // sits above TabsProvider in the tree (task 5.1). We use useContext directly
  // (without throwing) so that TabsProvider can be used in test environments
  // that do not wrap it in FocusedConnectionProvider.
  const focusedCtx = useContext(FocusedConnectionCtxRef);
  const focusedConnectionId = focusedCtx?.focusedConnectionId ?? null;

  // ---------------------------------------------------------------------------
  // Internal helpers that operate on the map
  // ---------------------------------------------------------------------------

  /** Get the set for a key, or an empty set if not yet present. */
  function getSet(
    sets: Map<string, ConnectionTabSet>,
    key: string,
  ): ConnectionTabSet {
    return sets.get(key) ?? { tabs: [], activeTabId: null };
  }

  /** Return a new map with the set for `key` replaced by `set`. */
  function putSet(
    sets: Map<string, ConnectionTabSet>,
    key: string,
    set: ConnectionTabSet,
  ): Map<string, ConnectionTabSet> {
    const next = new Map(sets);
    next.set(key, set);
    return next;
  }

  // ---------------------------------------------------------------------------
  // open
  // ---------------------------------------------------------------------------

  const open = useCallback(
    (input: OpenInput): string => {
      // Resolve target connection: payload.connectionId → focusedConnectionId.
      const targetKey =
        extractConnectionId(input) ?? focusedConnectionId;

      if (!targetKey) {
        // No resolvable connection — no-op.
        return "";
      }

      let outId = "";

      setAllSets((prev) => {
        const set = getSet(prev, targetKey);

        // Singleton by explicit id: focus the existing tab if present.
        if (input.id) {
          const existing = set.tabs.find((t) => t.id === input.id);
          if (existing) {
            outId = existing.id;
            const newSet: ConnectionTabSet = {
              ...set,
              activeTabId: existing.id,
            };
            return putSet(prev, targetKey, newSet);
          }
        }

        const id = input.id ?? nextId(input.kind);
        const tab: Tab = {
          id,
          kind: input.kind,
          title: input.title,
          closable: input.closable ?? true,
          payload: input.payload,
        };
        outId = id;
        const newSet: ConnectionTabSet = {
          tabs: [...set.tabs, tab],
          activeTabId: id,
        };
        return putSet(prev, targetKey, newSet);
      });

      return outId;
    },
    [focusedConnectionId],
  );

  // ---------------------------------------------------------------------------
  // close
  // ---------------------------------------------------------------------------

  const close = useCallback((id: string) => {
    setAllSets((prev) => {
      const key = findSetKey(prev, id);
      if (!key) return prev;
      const set = getSet(prev, key);
      const idx = set.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = set.tabs.filter((t) => t.id !== id);

      let newActiveTabId = set.activeTabId;
      if (newActiveTabId === id) {
        if (next.length === 0) {
          newActiveTabId = null;
        } else {
          const newIdx = Math.max(0, idx - 1);
          newActiveTabId =
            next[Math.min(newIdx, next.length - 1)]?.id ?? null;
        }
      }

      const newSet: ConnectionTabSet = {
        tabs: next,
        activeTabId: newActiveTabId,
      };
      return putSet(prev, key, newSet);
    });
  }, []);

  // ---------------------------------------------------------------------------
  // activate
  // ---------------------------------------------------------------------------

  const activate = useCallback((id: string) => {
    setAllSets((prev) => {
      const key = findSetKey(prev, id);
      if (!key) return prev;
      const set = getSet(prev, key);
      if (!set.tabs.some((t) => t.id === id)) return prev;
      const newSet: ConnectionTabSet = { ...set, activeTabId: id };
      return putSet(prev, key, newSet);
    });
  }, []);

  // ---------------------------------------------------------------------------
  // move — operates within the focused connection's set
  // ---------------------------------------------------------------------------

  const move = useCallback(
    (from: number, to: number) => {
      if (!focusedConnectionId) return;
      setAllSets((prev) => {
        const key = focusedConnectionId;
        const set = getSet(prev, key);
        if (
          from < 0 ||
          to < 0 ||
          from >= set.tabs.length ||
          to >= set.tabs.length ||
          from === to
        ) {
          return prev;
        }
        const next = set.tabs.slice();
        const [moved] = next.splice(from, 1);
        if (moved) next.splice(to, 0, moved);
        const newSet: ConnectionTabSet = { ...set, tabs: next };
        return putSet(prev, key, newSet);
      });
    },
    [focusedConnectionId],
  );

  // ---------------------------------------------------------------------------
  // cycle — operates within the focused connection's set
  // ---------------------------------------------------------------------------

  const cycle = useCallback(
    (direction: 1 | -1) => {
      if (!focusedConnectionId) return;
      setAllSets((prev) => {
        const key = focusedConnectionId;
        const set = getSet(prev, key);
        if (set.tabs.length === 0) return prev;
        const cur = set.activeTabId;
        const idx = cur ? set.tabs.findIndex((t) => t.id === cur) : -1;
        const nextIdx =
          (idx + direction + set.tabs.length) % set.tabs.length;
        const newActiveTabId = set.tabs[nextIdx]?.id ?? cur;
        if (newActiveTabId === cur) return prev;
        const newSet: ConnectionTabSet = {
          ...set,
          activeTabId: newActiveTabId,
        };
        return putSet(prev, key, newSet);
      });
    },
    [focusedConnectionId],
  );

  // ---------------------------------------------------------------------------
  // setTabTitle
  // ---------------------------------------------------------------------------

  const setTabTitle = useCallback((id: string, title: string) => {
    setAllSets((prev) => {
      const key = findSetKey(prev, id);
      if (!key) return prev;
      const set = getSet(prev, key);
      const idx = set.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = set.tabs.slice();
      next[idx] = { ...next[idx]!, title };
      const newSet: ConnectionTabSet = { ...set, tabs: next };
      return putSet(prev, key, newSet);
    });
  }, []);

  // ---------------------------------------------------------------------------
  // setTabDirty
  // ---------------------------------------------------------------------------

  const setTabDirty = useCallback((id: string, dirty: boolean) => {
    setAllSets((prev) => {
      const key = findSetKey(prev, id);
      if (!key) return prev;
      const set = getSet(prev, key);
      const idx = set.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      if (set.tabs[idx]!.dirty === dirty) return prev;
      const next = set.tabs.slice();
      next[idx] = { ...next[idx]!, dirty };
      const newSet: ConnectionTabSet = { ...set, tabs: next };
      return putSet(prev, key, newSet);
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Public context value: project focused connection's set
  // ---------------------------------------------------------------------------

  const focusedSet = focusedConnectionId
    ? (allSets.get(focusedConnectionId) ?? { tabs: [], activeTabId: null })
    : { tabs: [], activeTabId: null };

  const value = useMemo<TabsCtx>(
    () => ({
      tabs: focusedSet.tabs,
      activeTabId: focusedSet.activeTabId,
      open,
      close,
      activate,
      move,
      cycle,
      setTabTitle,
      setTabDirty,
      _allSets: allSets as ReadonlyMap<string, ConnectionTabSet>,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      focusedSet.tabs,
      focusedSet.activeTabId,
      open,
      close,
      activate,
      move,
      cycle,
      setTabTitle,
      setTabDirty,
      allSets,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTabs() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTabs must be used inside TabsProvider");
  return v;
}

// Export internal type for TabContent's cross-connection mounting.
export type { ConnectionTabSet };
