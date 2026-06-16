import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import {
  CONTEXT_CHANGED_EVENT,
  type ContextChangedEvent,
  type ContextChangeKind,
} from "./types";

type Listener = (event: ContextChangedEvent) => void;

interface ContextEventBus {
  /**
   * Subscribe to events for a specific canonical folder path.
   * Returns an unsubscribe function.
   */
  subscribe(path: string, listener: Listener): () => void;

  /**
   * Subscribe to ALL context events regardless of path.
   * Useful for high-level UI (e.g. unavailability banners).
   */
  subscribeAll(listener: Listener): () => void;
}

const Ctx = createContext<ContextEventBus | null>(null);

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export function ContextEventBusProvider({ children }: { children: ReactNode }) {
  // Per-path subscribers + global subscribers. Using refs so that
  // subscribe/unsubscribe doesn't trigger re-renders.
  const perPathRef = useRef<Map<string, Set<Listener>>>(new Map());
  const allRef = useRef<Set<Listener>>(new Set());

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<ContextChangedEvent>(CONTEXT_CHANGED_EVENT, (event) => {
      const payload = event.payload;
      // Fan out to per-path listeners.
      const pathListeners = perPathRef.current.get(payload.path);
      if (pathListeners) {
        for (const l of pathListeners) {
          try {
            l(payload);
          } catch {
            /* swallow listener errors to protect siblings */
          }
        }
      }
      // Fan out to global listeners.
      for (const l of allRef.current) {
        try {
          l(payload);
        } catch {
          /* same */
        }
      }
    }).then((un) => {
      if (cancelled) {
        un();
        return;
      }
      unlisten = un;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const bus = useMemo<ContextEventBus>(
    () => ({
      subscribe(path, listener) {
        let set = perPathRef.current.get(path);
        if (!set) {
          set = new Set();
          perPathRef.current.set(path, set);
        }
        set.add(listener);
        return () => {
          const cur = perPathRef.current.get(path);
          if (!cur) return;
          cur.delete(listener);
          if (cur.size === 0) perPathRef.current.delete(path);
        };
      },
      subscribeAll(listener) {
        allRef.current.add(listener);
        return () => {
          allRef.current.delete(listener);
        };
      },
    }),
    [],
  );

  return <Ctx.Provider value={bus}>{children}</Ctx.Provider>;
}

export function useContextEventBus(): ContextEventBus {
  const v = useContext(Ctx);
  if (!v) throw new Error("useContextEventBus must be used inside ContextEventBusProvider");
  return v;
}

/**
 * Convenience hook: subscribe to events for `path`, optionally filtered by
 * the `kinds` set. Listener is re-registered when path/kinds change.
 *
 * `path` may be null/undefined — in that case the hook is a no-op (handy when
 * the consumer doesn't yet know if a connection is linked).
 */
export function useContextChangeListener(
  path: string | null | undefined,
  kinds: ContextChangeKind[] | "all",
  listener: Listener,
): void {
  const bus = useContextEventBus();
  // Stash listener in a ref so the effect doesn't re-subscribe on every render.
  const ref = useRef(listener);
  useEffect(() => {
    ref.current = listener;
  }, [listener]);

  const kindsKey = kinds === "all" ? "all" : kinds.slice().sort().join(",");

  useEffect(() => {
    if (!path) return;
    return bus.subscribe(path, (event) => {
      if (kinds !== "all") {
        const intersects = event.kinds.some((k) => (kinds as ContextChangeKind[]).includes(k));
        if (!intersects) return;
      }
      ref.current(event);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus, path, kindsKey]);
}
