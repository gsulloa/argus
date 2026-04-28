import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Tab } from "./types";

type OpenInput = Omit<Tab, "id" | "closable"> & {
  id?: string;
  closable?: boolean;
};

interface TabsCtx {
  tabs: Tab[];
  activeTabId: string | null;
  open: (input: OpenInput) => string;
  close: (id: string) => void;
  activate: (id: string) => void;
  move: (fromIndex: number, toIndex: number) => void;
  cycle: (direction: 1 | -1) => void;
}

const Ctx = createContext<TabsCtx | null>(null);

let counter = 0;
function nextId(prefix: string) {
  counter += 1;
  return `${prefix}-${counter}-${Date.now().toString(36)}`;
}

export function TabsProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const open = useCallback((input: OpenInput): string => {
    let outId = "";
    setTabs((prev) => {
      // Singleton kinds (no payload) — focus the existing tab if any.
      if (input.id) {
        const existing = prev.find((t) => t.id === input.id);
        if (existing) {
          outId = existing.id;
          setActiveTabId(existing.id);
          return prev;
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
      setActiveTabId(id);
      return [...prev, tab];
    });
    return outId;
  }, []);

  const close = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.id !== id);
      setActiveTabId((cur) => {
        if (cur !== id) return cur;
        if (next.length === 0) return null;
        const newIdx = Math.max(0, idx - 1);
        return next[Math.min(newIdx, next.length - 1)]?.id ?? null;
      });
      return next;
    });
  }, []);

  const activate = useCallback((id: string) => {
    setTabs((prev) => {
      if (!prev.some((t) => t.id === id)) return prev;
      setActiveTabId(id);
      return prev;
    });
  }, []);

  const move = useCallback((from: number, to: number) => {
    setTabs((prev) => {
      if (from < 0 || to < 0 || from >= prev.length || to >= prev.length || from === to) {
        return prev;
      }
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const cycle = useCallback((direction: 1 | -1) => {
    setTabs((prev) => {
      if (prev.length === 0) return prev;
      setActiveTabId((cur) => {
        const idx = cur ? prev.findIndex((t) => t.id === cur) : -1;
        const nextIdx = (idx + direction + prev.length) % prev.length;
        return prev[nextIdx]?.id ?? cur;
      });
      return prev;
    });
  }, []);

  const value = useMemo<TabsCtx>(
    () => ({ tabs, activeTabId, open, close, activate, move, cycle }),
    [tabs, activeTabId, open, close, activate, move, cycle],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTabs() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTabs must be used inside TabsProvider");
  return v;
}
