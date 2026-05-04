import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { connectionGroupsApi } from "./api";
import type {
  ConnectionGroup,
  ConnectionGroupInput,
  ConnectionGroupUpdate,
} from "./types";

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

interface ConnectionGroupsContextValue {
  items: ConnectionGroup[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (input: ConnectionGroupInput) => Promise<ConnectionGroup>;
  update: (id: string, patch: ConnectionGroupUpdate) => Promise<ConnectionGroup>;
  remove: (id: string) => Promise<void>;
}

const Ctx = createContext<ConnectionGroupsContextValue | null>(null);

export function ConnectionGroupsProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ConnectionGroup[]>([]);
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
      const list = await connectionGroupsApi.list();
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

  const create = useCallback(
    async (input: ConnectionGroupInput) => {
      const created = await connectionGroupsApi.create(input);
      await refresh();
      return created;
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, patch: ConnectionGroupUpdate) => {
      const updated = await connectionGroupsApi.update(id, patch);
      await refresh();
      return updated;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await connectionGroupsApi.delete(id);
      await refresh();
    },
    [refresh],
  );

  const value = useMemo(
    () => ({ items, loading, error, refresh, create, update, remove }),
    [items, loading, error, refresh, create, update, remove],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConnectionGroups(): ConnectionGroupsContextValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error("useConnectionGroups must be used within ConnectionGroupsProvider");
  }
  return v;
}
