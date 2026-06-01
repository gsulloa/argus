import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { mssqlApi } from "./api";
import type { ActiveConnection } from "./types";

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

const ACTIVE_EVENT = "mssql:active-changed";

export function useActiveMssqlConnections() {
  const [items, setItems] = useState<ActiveConnection[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!isTauriRuntime()) {
      setItems([]);
      setLoading(false);
      return;
    }
    try {
      const list = await mssqlApi.listActive();
      setItems(list);
    } catch (e) {
      console.warn("[mssql] listActive failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<unknown>(ACTIVE_EVENT, () => {
      void refresh();
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refresh]);

  const byId = useMemo(() => {
    const m = new Map<string, ActiveConnection>();
    for (const it of items) m.set(it.id, it);
    return m;
  }, [items]);

  const isActive = useCallback((id: string) => byId.has(id), [byId]);
  const getActive = useCallback((id: string) => byId.get(id), [byId]);

  return { items, loading, refresh, isActive, getActive };
}
