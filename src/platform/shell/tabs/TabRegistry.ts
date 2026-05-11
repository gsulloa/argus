import type { ComponentType } from "react";
import type { Tab } from "./types";

export type TabRenderer = ComponentType<{ tab: Tab; active: boolean }>;

const registry = new Map<string, TabRenderer>();
const listeners = new Set<() => void>();

export const TabRegistry = {
  register(kind: string, component: TabRenderer): () => void {
    registry.set(kind, component);
    listeners.forEach((l) => l());
    return () => {
      const cur = registry.get(kind);
      if (cur === component) {
        registry.delete(kind);
        listeners.forEach((l) => l());
      }
    };
  },
  unregister(kind: string) {
    if (registry.delete(kind)) listeners.forEach((l) => l());
  },
  get(kind: string): TabRenderer | undefined {
    return registry.get(kind);
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
