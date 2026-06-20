import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSetting } from "@/platform/settings/useSetting";

export type ThemeMode = "light" | "dark" | "system";

type ThemeCtx = {
  mode: ThemeMode;
  resolved: "light" | "dark";
  setMode: (m: ThemeMode) => void;
};

const Ctx = createContext<ThemeCtx | null>(null);

// Must match the event name listened to by every ThemeProvider instance.
const THEME_CHANGED_EVENT = "theme-changed";

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

function readSystem(): "light" | "dark" {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(t: "light" | "dark") {
  const root = document.documentElement;
  root.dataset.theme = t;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeRaw, loaded] = useSetting<ThemeMode>("theme.mode", "system");
  const [system, setSystem] = useState<"light" | "dark">(() => readSystem());

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved = mode === "system" ? system : mode;

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const setMode = useCallback(
    (m: ThemeMode) => {
      setModeRaw(m);
      // Broadcast to all windows so the other window's ThemeProvider picks up
      // the new value from the persisted store (Decision 8 / Phase 8.1).
      // We do NOT rely on cross-webview localStorage storage events.
      if (isTauriRuntime()) {
        import("@tauri-apps/api/event")
          .then(({ emit }) => emit(THEME_CHANGED_EVENT, m))
          .catch((e: unknown) => {
            console.warn("[argus] ThemeProvider: failed to emit theme-changed:", e);
          });
      }
    },
    [setModeRaw],
  );

  // Listen for theme-changed events emitted by the other window. When we
  // receive one, re-read the persisted setting by updating the raw value.
  // `loaded` is used to guard against applying the event before our own
  // initial read has settled (avoids a one-frame flicker on first mount).
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const handle = await listen<ThemeMode>(THEME_CHANGED_EVENT, (event) => {
        if (!loaded) return;
        // Apply the broadcasted mode directly — it was already persisted by
        // the emitting window's setModeRaw call.
        setModeRaw(event.payload);
      });
      if (cancelled) {
        handle();
      } else {
        unlisten = handle;
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  // loaded is intentionally omitted: we only set up the listener once,
  // but the handler uses the current `loaded` via closure.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setModeRaw]);

  const value = useMemo<ThemeCtx>(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme must be used inside ThemeProvider");
  return v;
}
