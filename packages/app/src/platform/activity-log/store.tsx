import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ACTIVITY_LOG_CAPACITY,
  ACTIVITY_LOG_EVENT,
  type ActivityLogEntry,
  type Origin,
} from "./types";

interface State {
  entries: ActivityLogEntry[];
  counts: { user: number; auto: number; total: number };
}

type Action =
  | { type: "append"; entry: ActivityLogEntry }
  | { type: "clear" };

function emptyState(): State {
  return { entries: [], counts: { user: 0, auto: 0, total: 0 } };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "append": {
      const atCapacity = state.entries.length >= ACTIVITY_LOG_CAPACITY;
      const dropped = atCapacity ? state.entries[0] : null;
      const next = atCapacity
        ? state.entries.slice(state.entries.length - ACTIVITY_LOG_CAPACITY + 1)
        : state.entries.slice();
      const droppedAuto = dropped?.origin === "auto" ? 1 : 0;
      const droppedUser = dropped?.origin === "user" ? 1 : 0;
      next.push(action.entry);
      const counts = {
        auto: state.counts.auto + (action.entry.origin === "auto" ? 1 : 0) - droppedAuto,
        user: state.counts.user + (action.entry.origin === "user" ? 1 : 0) - droppedUser,
        total: next.length,
      };
      return { entries: next, counts };
    }
    case "clear":
      return emptyState();
  }
}

interface ActivityLogContextValue {
  entries: ActivityLogEntry[];
  counts: { user: number; auto: number; total: number };
  clear: () => void;
}

const Ctx = createContext<ActivityLogContextValue | null>(null);

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export function ActivityLogProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, emptyState);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<ActivityLogEntry>(ACTIVITY_LOG_EVENT, (event) => {
      dispatch({ type: "append", entry: event.payload });
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

  const clear = useCallback(() => dispatch({ type: "clear" }), []);

  const value = useMemo(
    () => ({ entries: state.entries, counts: state.counts, clear }),
    [state.entries, state.counts, clear],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useActivityLog(): ActivityLogContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useActivityLog must be used inside ActivityLogProvider");
  return v;
}

export function useFilteredActivityLog(showAuto: boolean): ActivityLogEntry[] {
  const { entries } = useActivityLog();
  return useMemo(
    () => (showAuto ? entries : entries.filter((e) => e.origin === "user")),
    [entries, showAuto],
  );
}

export function useFilteredCount(showAuto: boolean): number {
  const { counts } = useActivityLog();
  return showAuto ? counts.total : counts.user;
}

export type { ActivityLogEntry, Origin };
