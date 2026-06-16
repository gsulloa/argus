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

export function useSetting<T>(
  key: string,
  defaultValue: T,
): [T, (next: Updater<T>) => void, boolean] {
  const [value, setValue] = useState<T>(() => {
    const cached = memoryCache.get(key);
    return cached === undefined ? defaultValue : (cached as T);
  });
  // Outside Tauri (jsdom tests, plain web) there is no async disk read, so
  // first paint is already authoritative. Inside Tauri we flip on the read
  // settling. Cached values in `memoryCache` from a prior mount also count
  // as "loaded" — re-reading the disk would only confirm them.
  const [loaded, setLoaded] = useState<boolean>(
    () => memoryCache.has(key) || !isTauriRuntime(),
  );
  const initialized = useRef(false);
  const writeTimer = useRef<number | null>(null);

  // When the same hook instance is re-rendered with a different `key` (e.g.
  // TabContent reuses one TableViewerTab across two tabs of different
  // relations), `useState` initializers don't re-run — `value` would stay
  // pinned to the previous key's data. Detect the change synchronously and
  // re-derive both pieces of state from memory cache. We track `prevKey`
  // with `useState` (not `useRef`) so the React docs' pattern survives a
  // discarded render in StrictMode dev double-invocation: a ref mutation
  // would stick across the discard, but a queued setState gets discarded
  // alongside `setValue`/`setLoaded`, so the next render fires the branch
  // again and self-corrects.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    const cached = memoryCache.get(key);
    setValue(cached === undefined ? defaultValue : (cached as T));
    setLoaded(memoryCache.has(key) || !isTauriRuntime());
  }

  // Load on mount.
  useEffect(() => {
    let cancelled = false;
    if (!isTauriRuntime()) {
      initialized.current = true;
      setLoaded(true);
      return;
    }
    if (memoryCache.has(key)) {
      initialized.current = true;
      setLoaded(true);
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
        setLoaded(true);
      })
      .catch(() => {
        initialized.current = true;
        setLoaded(true);
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

  return [value, update, loaded];
}
