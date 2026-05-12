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
import { invoke } from "@tauri-apps/api/core";
import { useSetting } from "@/platform/settings/useSetting";
import { logUpdater } from "./log";

const FIRST_CHECK_DELAY_MS = 5_000;
const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const SKIPPED_VERSION_KEY = "updater.skippedVersion";

type UpdateInfo = { version: string; body: string | null; date: string | null };

type UpdaterCtx = {
  currentVersion: string;
  pendingVersion: string | null;
  availableVersion: string | null;
  skippedVersion: string | null;
  isInstalling: boolean;
  installError: string | null;
  dismissInstallError: () => void;
  forceCheck: () => Promise<void>;
  skipPending: () => void;
  clearSkip: () => void;
  installAndRestart: () => Promise<void>;
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
  const [isInstalling, setIsInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  // Track latest values without re-running effects.
  const skippedRef = useRef(skippedVersion);
  skippedRef.current = skippedVersion;

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

    let result: UpdateInfo | null;
    try {
      result = await invoke<UpdateInfo | null>("updater_check_and_download");
    } catch (err) {
      logUpdater("warn", "check_failed", { error: String(err) });
      return;
    }

    if (result === null) {
      // No update available — clear any stale state.
      setAvailableVersion(null);
      setPendingVersion(null);
      return;
    }

    // Skip-version gating: if the user previously skipped this version,
    // don't surface it in the UI. Note: the bytes are already stored in Rust
    // state, so a quit while in this state would still apply the update.
    // TODO: add a `updater_clear_pending` Rust command to fully clear skip.
    if (skippedRef.current && result.version === skippedRef.current) {
      logUpdater("info", "skipped_version_seen", { version: result.version });
      setPendingVersion(null);
      setAvailableVersion(null);
      return;
    }

    setAvailableVersion(result.version);
    setPendingVersion(result.version);
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

  // Note: the beforeunload useEffect has been removed. Quit-time install is
  // now handled by the Rust RunEvent::ExitRequested hook, which deterministically
  // blocks exit until install completes (with a 10s timeout).

  const forceCheck = useCallback(async () => {
    logUpdater("info", "user_forced_check");
    await runCheck();
  }, [runCheck]);

  const skipPending = useCallback(() => {
    const v = pendingVersion ?? availableVersion;
    if (!v) return;
    logUpdater("info", "user_skipped_version", { version: v });
    setSkippedVersion(v);
    setPendingVersion(null);
    setAvailableVersion(null);
  }, [pendingVersion, availableVersion, setSkippedVersion]);

  const clearSkip = useCallback(() => {
    logUpdater("info", "user_cleared_skip");
    setSkippedVersion(null);
  }, [setSkippedVersion]);

  const dismissInstallError = useCallback(() => {
    setInstallError(null);
  }, []);

  const installAndRestart = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setIsInstalling(true);
    try {
      await invoke<void>("updater_install_and_restart");
      // On success, the process is gone — this line is unreachable.
    } catch (err) {
      const msg = String(err);
      setInstallError(msg);
      logUpdater("error", "install_and_restart_failed", { error: msg });
      setIsInstalling(false);
    }
  }, []);

  const value = useMemo<UpdaterCtx>(
    () => ({
      currentVersion,
      pendingVersion,
      availableVersion,
      skippedVersion,
      isInstalling,
      installError,
      dismissInstallError,
      forceCheck,
      skipPending,
      clearSkip,
      installAndRestart,
    }),
    [
      currentVersion,
      pendingVersion,
      availableVersion,
      skippedVersion,
      isInstalling,
      installError,
      dismissInstallError,
      forceCheck,
      skipPending,
      clearSkip,
      installAndRestart,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
