import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useOpenConnections } from "@/platform/connection-registry/useOpenConnections";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FocusedConnectionCtx {
  focusedConnectionId: string | null;
  setFocused: (id: string | null) => void;
}

export const FocusedConnectionCtxRef = createContext<FocusedConnectionCtx | null>(null);

// Internal alias used by FocusedConnectionProvider and TabsProvider.
const Ctx = FocusedConnectionCtxRef;

export function useFocusedConnection(): FocusedConnectionCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useFocusedConnection must be used inside FocusedConnectionProvider");
  return v;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Workspace-local focused-connection store (Decision 4).
 *
 * Rules:
 * - On mount and whenever the open set changes: if there is no focused id, or
 *   the focused id is no longer in the open set, default to the first open
 *   connection; if none are open, focus is null.
 * - `setFocused` is the explicit user action (clicking a rail item).
 */
export function FocusedConnectionProvider({ children }: { children: ReactNode }) {
  const { items, loading } = useOpenConnections();
  const [focusedConnectionId, setFocusedConnectionId] = useState<string | null>(null);

  // Re-evaluate focus whenever the open list changes.
  useEffect(() => {
    if (loading) return;

    // If the currently-focused id is still in the open set, keep it.
    const stillOpen = items.some((it) => it.id === focusedConnectionId);
    if (focusedConnectionId !== null && stillOpen) return;

    // Default to first open connection, or null if the rail is empty.
    setFocusedConnectionId(items.length > 0 ? (items[0]?.id ?? null) : null);
  }, [items, loading, focusedConnectionId]);

  const setFocused = useCallback((id: string | null) => {
    setFocusedConnectionId(id);
  }, []);

  return (
    <Ctx.Provider value={{ focusedConnectionId, setFocused }}>
      {children}
    </Ctx.Provider>
  );
}
