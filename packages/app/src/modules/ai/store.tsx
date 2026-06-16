import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";

import { aiApi } from "./api";
import type { AiSettingsView, ProviderId, ProviderListEntry } from "./types";

// ---------------------------------------------------------------------------
// State & context shapes
// ---------------------------------------------------------------------------

interface AiState {
  settings: AiSettingsView | null;
  providers: ProviderListEntry[];
  loading: boolean;
  error: string | null;
}

interface AiSettingsContextValue extends AiState {
  refresh: () => Promise<void>;
}

const AiSettingsContext = createContext<AiSettingsContextValue | null>(null);

// Must match the constant in src-tauri/src/modules/ai/commands.rs
const SETTINGS_CHANGED_EVENT = "ai-settings-changed";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AiSettingsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AiState>({
    settings: null,
    providers: [],
    loading: true,
    error: null,
  });

  // Deduplicate concurrent refresh calls: if one is in flight, return the same promise.
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    const p = (async () => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const [settings, providers] = await Promise.all([
          aiApi.getSettings(),
          aiApi.listProviders(),
        ]);
        setState({ settings, providers, loading: false, error: null });
      } catch (e) {
        setState((s) => ({
          ...s,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = p;
    return p;
  }, []);

  // Initial load on mount.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Subscribe to backend-emitted ai-settings-changed Tauri event.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const handle = await listen(SETTINGS_CHANGED_EVENT, () => {
        void refresh();
      });
      if (cancelled) {
        handle(); // unlisten immediately if effect was cleaned up before listen resolved
      } else {
        unlisten = handle;
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refresh]);

  // Revalidate when the window regains visibility (e.g. user switched away and back).
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refresh]);

  return (
    <AiSettingsContext.Provider value={{ ...state, refresh }}>
      {children}
    </AiSettingsContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useAiSettings(): AiSettingsContextValue {
  const ctx = useContext(AiSettingsContext);
  if (!ctx) {
    throw new Error("useAiSettings must be used within AiSettingsProvider");
  }
  return ctx;
}

/**
 * Resolve which provider is active for a given connection.
 * Returns the per-connection override if present, otherwise the global default.
 * Returns null when settings haven't loaded yet or no default is configured.
 */
export function useResolvedProviderId(connectionId: string | null): ProviderId | null {
  const { settings } = useAiSettings();
  if (!settings) return null;
  if (connectionId) {
    const ov = settings.overrides.find((o) => o.connection_id === connectionId);
    if (ov) return ov.provider_id;
  }
  return settings.default_provider;
}
