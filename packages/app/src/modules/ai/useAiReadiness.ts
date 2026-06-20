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
  /** When true, this connection does not require a context folder to reach
   * `ready`. The readiness level is derived from the provider prerequisite
   * alone and will NEVER be `needs-context`. */
  contextOptional?: boolean;
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
 *
 * When `contextOptional` is true (e.g. CloudWatch), the context-folder
 * prerequisite is ignored: a configured provider alone yields `ready`, and
 * `needs-context` is never returned.
 */
export function deriveReadinessLevel(
  providerConfigured: boolean,
  contextState: ContextState,
  contextOptional = false,
): ReadinessLevel {
  if (!providerConfigured) return "not-configured";
  if (contextOptional) return "ready";
  if (contextState === "available") return "ready";
  return "needs-context";
}

export interface UseAiReadinessOptions {
  /** When true, the context-folder prerequisite is ignored. The connection
   * reaches `ready` on a configured provider alone and NEVER resolves to
   * `needs-context`. Use for engines where a context folder is optional
   * enrichment rather than a hard requirement (e.g. CloudWatch). */
  contextOptional?: boolean;
}

/**
 * Derive the AI readiness state for a connection from two prerequisites — a
 * configured AI provider and an available context folder. Recomputes
 * reactively when AI settings or the context folder change.
 *
 * Pass `{ contextOptional: true }` for engines (e.g. CloudWatch) where the
 * context folder is optional: the hook will return `ready` as soon as a
 * provider is configured, regardless of folder state.
 */
export function useAiReadiness(
  connectionId: string | null,
  options?: UseAiReadinessOptions,
): AiReadiness {
  const contextOptional = options?.contextOptional ?? false;
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

  const level = deriveReadinessLevel(providerConfigured, contextState, contextOptional);

  return { providerConfigured, contextState, level, ...(contextOptional && { contextOptional: true }) };
}
