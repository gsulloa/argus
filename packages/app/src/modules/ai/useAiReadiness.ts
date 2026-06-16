import { useCallback, useEffect, useRef, useState } from "react";

import { contextApi } from "@/modules/context/api";
import { useContextChangeListener } from "@/modules/context/eventBus";
import { isMissingFolderError } from "@/modules/context/components/availability";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { useAiSettings } from "./store";
import type { AiSettingsView } from "./types";

export type ContextState = "none" | "available" | "missing" | "unknown";
export type ReadinessLevel = "not-configured" | "needs-context" | "ready";

export interface AiReadiness {
  providerConfigured: boolean;
  contextState: ContextState;
  level: ReadinessLevel;
}

/**
 * A provider is configured when a global default exists OR a per-connection
 * override exists for the active connection.
 */
export function isProviderConfigured(
  settings: AiSettingsView | null,
  connectionId: string | null,
): boolean {
  if (!settings) return false;
  if (settings.default_provider !== null) return true;
  if (
    connectionId &&
    settings.overrides.some((o) => o.connection_id === connectionId)
  )
    return true;
  return false;
}

/**
 * Map the two prerequisites to a single readiness level. `unknown` context
 * (availability not yet resolved) is treated as not-ready.
 */
export function deriveReadinessLevel(
  providerConfigured: boolean,
  contextState: ContextState,
): ReadinessLevel {
  if (!providerConfigured) return "not-configured";
  if (contextState === "available") return "ready";
  return "needs-context";
}

/**
 * Derive the AI readiness state for a connection from two prerequisites — a
 * configured AI provider and an available context folder. Recomputes
 * reactively when AI settings or the context folder change.
 */
export function useAiReadiness(connectionId: string | null): AiReadiness {
  const { settings } = useAiSettings();
  const { items } = useConnections();

  const contextPath = connectionId
    ? (items.find((c) => c.id === connectionId)?.context_path ?? null)
    : null;

  const providerConfigured = isProviderConfigured(settings, connectionId);

  const [contextState, setContextState] = useState<ContextState>("unknown");

  // Guards against a stale async result: if the connection/folder changes (or a
  // re-check fires) while a listObjects call is in flight, the older promise
  // must not clobber the newer state. Each check claims a sequence number and
  // only applies its result if it is still the latest.
  const checkSeq = useRef(0);

  const check = useCallback(() => {
    const seq = ++checkSeq.current;
    if (!connectionId || !contextPath) {
      setContextState("none");
      return;
    }
    contextApi
      .listObjects(connectionId)
      .then(() => {
        if (seq === checkSeq.current) setContextState("available");
      })
      .catch((err: unknown) => {
        if (seq !== checkSeq.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        // Mirror ContextFolderBanner: only missing-manifest style errors mark
        // the folder unavailable; other errors (permissions, etc.) are treated
        // as available so we don't wrongly block chat.
        setContextState(isMissingFolderError(msg) ? "missing" : "available");
      });
  }, [connectionId, contextPath]);

  useEffect(() => {
    check();
  }, [check]);

  useContextChangeListener(contextPath, "all", check);

  const level = deriveReadinessLevel(providerConfigured, contextState);

  return { providerConfigured, contextState, level };
}
