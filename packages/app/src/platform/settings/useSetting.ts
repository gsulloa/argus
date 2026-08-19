import { useCallback, useEffect, useRef, useState } from "react";
import { getSetting, setSetting } from "./api";

type Updater<T> = T | ((prev: T) => T);

const memoryCache = new Map<string, unknown>();

// Live subscribers per key, so two simultaneously-mounted hooks on the same
// key stay in step. `memoryCache` alone only helps a *newly* mounting hook:
// without this, a row-limit control in one query tab would keep showing a
// stale value after another tab (or a truncation banner's "Raise limit")
// wrote a new one.
const subscribers = new Map<string, Set<(value: unknown) => void>>();

function subscribe(key: string, fn: (value: unknown) => void): () => void {
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) subscribers.delete(key);
  };
}

/** Push `value` to every hook on `key` except the one that originated it. */
function broadcast(key: string, value: unknown, origin: (value: unknown) => void): void {
  const set = subscribers.get(key);
  if (!set) return;
  for (const fn of set) {
    if (fn !== origin) fn(value);
  }
}

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

  // Mirror of `value` for `update`'s functional form. Kept because `update`
  // no longer resolves the previous value inside a `setValue` updater — doing
  // so would mean calling other components' setters (via `broadcast`) from
  // inside a state updater, which React may invoke twice under StrictMode.
  const valueRef = useRef(value);
  valueRef.current = value;

  // Stable identity per hook instance, used both as the subscriber and as the
  // `broadcast` origin so a write never echoes back to its own author.
  const receive = useRef((incoming: unknown) => {
    setValue(incoming as T);
  }).current;

  useEffect(() => subscribe(key, receive), [key, receive]);

  const update = useCallback(
    (next: Updater<T>) => {
      // Prefer the shared cache as the base: another instance may have
      // written since this one last rendered.
      const prev = (memoryCache.has(key) ? memoryCache.get(key) : valueRef.current) as T;
      const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      memoryCache.set(key, resolved);
      setValue(resolved);
      broadcast(key, resolved, receive);
      if (!isTauriRuntime()) return;
      if (writeTimer.current !== null) {
        window.clearTimeout(writeTimer.current);
      }
      const serialized = JSON.stringify(resolved);
      writeTimer.current = window.setTimeout(() => {
        setSetting(key, serialized).catch(() => {
          // best-effort persistence; swallow to avoid breaking UI
        });
      }, 150);
    },
    [key, receive],
  );

  return [value, update, loaded];
}
