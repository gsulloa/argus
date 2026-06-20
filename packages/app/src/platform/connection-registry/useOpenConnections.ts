import { useCallback, useMemo, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";

// ---------------------------------------------------------------------------
// Types — mirror the Rust `OpenConnection` struct (camelCase via serde).
// ---------------------------------------------------------------------------

export interface OpenConnection {
  id: string;
  kind: string;
  name: string;
  connectedAtUnixMs: number;
}

const OPEN_CHANGED_EVENT = "connections:open-changed";

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

// ---------------------------------------------------------------------------
// Singleton store
//
// `useOpenConnections` is the cross-engine source of truth for which
// connections are open. It MUST be a single shared store rather than per-hook
// state: the Workspace mounts several consumers (the rail, the focused-
// connection provider, the lifecycle effects) and the Manager mounts one per
// connection row. If each kept its own `useState`, a manual `refresh()` from
// one consumer would not update the others. A module-level store with one
// Tauri listener and one snapshot keeps every consumer in lockstep and lets
// any consumer trigger a global re-sync (e.g. on window focus, when a live
// `connections:open-changed` event may have been missed while occluded).
// ---------------------------------------------------------------------------

let snapshot: OpenConnection[] = [];
let loaded = false;
const listeners = new Set<() => void>();
let started = false;

function emit() {
  for (const cb of listeners) cb();
}

function setSnapshot(next: OpenConnection[]) {
  snapshot = next;
  loaded = true;
  emit();
}

/** Re-fetch the open set from the backend and update the shared snapshot. */
export async function refreshOpenConnections(): Promise<void> {
  if (!isTauriRuntime()) {
    setSnapshot([]);
    return;
  }
  try {
    const list = await invoke<OpenConnection[]>("connections_open_list");
    setSnapshot(list);
  } catch (e) {
    console.warn(
      "[argus] useOpenConnections: failed to fetch open list:",
      toAppError(e),
    );
    // Mark as loaded even on failure so consumers stop showing "loading".
    loaded = true;
    emit();
  }
}

/** Lazily start the single Tauri listener + initial seed on first subscribe. */
function start() {
  if (started) return;
  started = true;
  if (!isTauriRuntime()) {
    loaded = true;
    return;
  }
  void refreshOpenConnections();
  // The backend emits the full updated list as the payload, so apply directly.
  void listen<OpenConnection[]>(OPEN_CHANGED_EVENT, (event) => {
    setSnapshot(event.payload);
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  start();
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): OpenConnection[] {
  return snapshot;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Cross-engine source of truth for which connections are currently open.
 *
 * Backed by a singleton store: one `connections:open-changed` listener and one
 * snapshot shared across every consumer in the window.
 *
 * Returns:
 *   - `items`   — sorted list of open connections (same order as backend)
 *   - `isOpen`  — predicate checking whether a connection id is open
 *   - `loading` — true until the first fetch resolves
 *   - `refresh` — force a re-sync from the backend (updates ALL consumers)
 */
export function useOpenConnections() {
  const items = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const loading = !loaded;

  const byId = useMemo(() => {
    const m = new Map<string, OpenConnection>();
    for (const it of items) m.set(it.id, it);
    return m;
  }, [items]);

  const isOpen = useCallback((id: string) => byId.has(id), [byId]);
  const getOpen = useCallback((id: string) => byId.get(id), [byId]);
  const refresh = useCallback(() => refreshOpenConnections(), []);

  return { items, loading, isOpen, getOpen, refresh };
}
