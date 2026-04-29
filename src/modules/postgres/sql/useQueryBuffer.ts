import { useCallback, useEffect, useRef, useState } from "react";
import { getSetting, setSetting } from "@/platform/settings/api";

function settingsKey(tabId: string): string {
  return `pgQueryBuffer:${tabId}`;
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

/**
 * Persisted-per-tab SQL buffer. Reads `pgQueryBuffer:<tabId>` on mount,
 * writes back debounced 500ms on change. Cleans up the key on unmount so
 * a closed tab doesn't leak settings.
 *
 * Returns:
 * - `loaded`: true once the initial read finished (the editor mounts only
 *   after this so that `initialSql` is correct).
 * - `initialSql`: the string to seed the editor with.
 * - `update`: call from the editor's `onChange`.
 */
export function useQueryBuffer(
  tabId: string,
  fallback: string,
): { loaded: boolean; initialSql: string; update: (next: string) => void } {
  const [loaded, setLoaded] = useState(false);
  const [initialSql, setInitialSql] = useState(fallback);
  const writeTimer = useRef<number | null>(null);
  // Latest value flushed (avoid races on unmount).
  const latestRef = useRef<string>(fallback);

  useEffect(() => {
    let cancelled = false;
    if (!isTauriRuntime()) {
      setLoaded(true);
      return;
    }
    getSetting(settingsKey(tabId))
      .then((raw) => {
        if (cancelled) return;
        if (raw !== null) {
          try {
            const parsed = JSON.parse(raw) as string;
            setInitialSql(parsed);
            latestRef.current = parsed;
          } catch {
            // ignore malformed
          }
        }
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [tabId]);

  const update = useCallback(
    (next: string) => {
      latestRef.current = next;
      if (!isTauriRuntime()) return;
      if (writeTimer.current !== null) window.clearTimeout(writeTimer.current);
      writeTimer.current = window.setTimeout(() => {
        setSetting(settingsKey(tabId), JSON.stringify(next)).catch(() => {});
      }, 500);
    },
    [tabId],
  );

  // Cleanup: drop the key on unmount.
  useEffect(() => {
    return () => {
      if (writeTimer.current !== null) window.clearTimeout(writeTimer.current);
      if (!isTauriRuntime()) return;
      // Flush the latest value before deleting? On close we drop. The spec
      // says: closing a tab discards the buffer.
      setSetting(settingsKey(tabId), JSON.stringify("")).catch(() => {});
    };
  }, [tabId]);

  return { loaded, initialSql, update };
}
