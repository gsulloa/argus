import { useCallback, useEffect, useState } from "react";
import { connectionsApi } from "./api";
import type { Connection, ConnectionInput, ConnectionUpdate } from "./types";

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export function useConnections() {
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

  const remove = useCallback(
    async (id: string) => {
      await connectionsApi.delete(id);
      await refresh();
    },
    [refresh],
  );

  return { items, loading, error, refresh, create, update, remove };
}
