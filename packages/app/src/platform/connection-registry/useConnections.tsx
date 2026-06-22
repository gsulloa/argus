import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { connectionsApi } from "./api";
import type {
  Connection,
  ConnectionInput,
  ConnectionMove,
  ConnectionUpdate,
} from "./types";

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

interface ConnectionsContextValue {
  items: Connection[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (input: ConnectionInput) => Promise<Connection>;
  update: (id: string, patch: ConnectionUpdate) => Promise<Connection>;
  move: (id: string, move: ConnectionMove) => Promise<Connection>;
  remove: (id: string) => Promise<void>;
}

const Ctx = createContext<ConnectionsContextValue | null>(null);

export function ConnectionsProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauriRuntime()) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await connectionsApi.list();
      setItems(list);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Cross-window refresh: when the connection-form window saves a connection
  // it emits `connections:registry-changed`. All windows listen and refresh.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const unlistenPromise = listen("connections:registry-changed", () => {
      void refresh();
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [refresh]);

  const create = useCallback(
    async (input: ConnectionInput) => {
      const created = await connectionsApi.create(input);
      await refresh();
      return created;
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, patch: ConnectionUpdate) => {
      const updated = await connectionsApi.update(id, patch);
      await refresh();
      return updated;
    },
    [refresh],
  );

  const move = useCallback(
    async (id: string, m: ConnectionMove) => {
      const moved = await connectionsApi.move(id, m);
      await refresh();
      return moved;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await connectionsApi.delete(id);
      await refresh();
    },
    [refresh],
  );

  const value = useMemo(
    () => ({ items, loading, error, refresh, create, update, move, remove }),
    [items, loading, error, refresh, create, update, move, remove],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConnections(): ConnectionsContextValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error("useConnections must be used within ConnectionsProvider");
  }
  return v;
}
