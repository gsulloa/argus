import { useCallback, useEffect, useRef, useState } from "react";
import { getSetting, setSetting } from "./api";

type Updater<T> = T | ((prev: T) => T);

const memoryCache = new Map<string, unknown>();

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export function useSetting<T>(key: string, defaultValue: T): [T, (next: Updater<T>) => void] {
  const [value, setValue] = useState<T>(() => {
    const cached = memoryCache.get(key);
    return cached === undefined ? defaultValue : (cached as T);
  });
  const initialized = useRef(false);
  const writeTimer = useRef<number | null>(null);

  // Load on mount.
  useEffect(() => {
    let cancelled = false;
    if (!isTauriRuntime()) {
      initialized.current = true;
      return;
    }
    getSetting(key)
      .then((raw) => {
        if (cancelled) return;
        if (raw !== null) {
          try {
            const parsed = JSON.parse(raw) as T;
            memoryCache.set(key, parsed);
            setValue(parsed);
          } catch {
            // ignore malformed entries — keep default
          }
        }
        initialized.current = true;
      })
      .catch(() => {
        initialized.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const update = useCallback(
    (next: Updater<T>) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        memoryCache.set(key, resolved);
        if (!isTauriRuntime()) return resolved;
        if (writeTimer.current !== null) {
          window.clearTimeout(writeTimer.current);
        }
        const serialized = JSON.stringify(resolved);
        writeTimer.current = window.setTimeout(() => {
          setSetting(key, serialized).catch(() => {
            // best-effort persistence; swallow to avoid breaking UI
          });
        }, 150);
        return resolved;
      });
    },
    [key],
  );

  return [value, update];
}
