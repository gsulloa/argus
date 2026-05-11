import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useSetting } from "@/platform/settings/useSetting";

const FIRST_CHECK_DELAY_MS = 5_000;
const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const SKIPPED_VERSION_KEY = "updater.skippedVersion";

type UpdaterCtx = {
  currentVersion: string;
  pendingVersion: string | null;
  availableVersion: string | null;
  skippedVersion: string | null;
  forceCheck: () => Promise<void>;
  skipPending: () => void;
  clearSkip: () => void;
};

const Ctx = createContext<UpdaterCtx | null>(null);

export function useUpdater(): UpdaterCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useUpdater must be used inside <UpdaterProvider>");
  return v;
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  const [skippedVersion, setSkippedVersion] = useSetting<string | null>(
    SKIPPED_VERSION_KEY,
    null,
  );

  // Track latest values without re-running effects.
  const skippedRef = useRef(skippedVersion);
  skippedRef.current = skippedVersion;
  const pendingRef = useRef<Update | null>(null);
  const installingRef = useRef(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    getVersion()
      .then((v) => {
        if (!cancelled) setCurrentVersion(v);
      })
      .catch(() => {
        // best-effort — leave empty string
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runCheck = useCallback(async () => {
    if (!isTauriRuntime()) return;
    if (pendingRef.current) return; // already downloaded; waiting for quit
    let update: Update | null;
    try {
      update = await check();
    } catch (err) {
      console.debug("[updater] check failed:", err);
      return;
    }
    if (!update || !update.available) return;
    if (skippedRef.current && update.version === skippedRef.current) {
      console.debug("[updater] version", update.version, "is skipped");
      return;
    }
    setAvailableVersion(update.version);
    try {
      await update.download();
      pendingRef.current = update;
      setPendingVersion(update.version);
    } catch (err) {
      console.debug("[updater] download failed:", err);
      setAvailableVersion(null);
    }
  }, []);

  // First check 5s after mount, then every 4h.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    let intervalId: number | null = null;
    const firstId = window.setTimeout(() => {
      if (cancelled) return;
      void runCheck();
      intervalId = window.setInterval(() => {
        if (!cancelled) void runCheck();
      }, PERIODIC_CHECK_INTERVAL_MS);
    }, FIRST_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(firstId);
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, [runCheck]);

  // Apply pending update on app quit. Tauri 2 fires beforeunload when the
  // user quits via ⌘Q or window close; we intercept synchronously and let
  // the install run. install() swaps the .app on disk; the next launch
  // picks up the new binary.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const handler = (event: BeforeUnloadEvent) => {
      const update = pendingRef.current;
      if (!update || installingRef.current) return;
      installingRef.current = true;
      // We can't await synchronously; fire-and-forget. The user-initiated
      // quit gives the install enough time on macOS where the swap is fast.
      event.preventDefault();
      update
        .install()
        .catch((err) => {
          console.debug("[updater] install on quit failed:", err);
        })
        .finally(() => {
          // Allow the unload to proceed.
          window.removeEventListener("beforeunload", handler);
          window.close();
        });
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const forceCheck = useCallback(async () => {
    await runCheck();
  }, [runCheck]);

  const skipPending = useCallback(() => {
    const v = pendingVersion ?? availableVersion;
    if (!v) return;
    setSkippedVersion(v);
    // Discard the pending download — user explicitly opted out.
    pendingRef.current = null;
    setPendingVersion(null);
    setAvailableVersion(null);
  }, [pendingVersion, availableVersion, setSkippedVersion]);

  const clearSkip = useCallback(() => {
    setSkippedVersion(null);
  }, [setSkippedVersion]);

  const value = useMemo<UpdaterCtx>(
    () => ({
      currentVersion,
      pendingVersion,
      availableVersion,
      skippedVersion,
      forceCheck,
      skipPending,
      clearSkip,
    }),
    [
      currentVersion,
      pendingVersion,
      availableVersion,
      skippedVersion,
      forceCheck,
      skipPending,
      clearSkip,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
