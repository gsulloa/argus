/**
 * FeedbackHost — mounts at the app-shell level (inside ShellMain).
 *
 * Responsibilities:
 *  1. Registers "Send feedback" in the CommandRegistry so the command palette
 *     can open the feedback window (same pattern as AiSettingsHost).
 *  2. Resolves the active engine type (connection.kind) for the submission
 *     metadata — the engine type string only, never the connection string or
 *     host (e.g. "postgres", "dynamo", "cloudwatch").
 *  3. Calls `ensure_feedback_window` to open the dedicated feedback window.
 *     No dialog is rendered here any more.
 *  4. (Nice-to-have) Listens for `argus:feedback:submitted` to show a
 *     success toast in the shell.
 *
 * Engine resolution:
 *   Both AppProviders windows (Manager + Workspace) mount
 *   FocusedConnectionProvider and ConnectionsProvider, so these hooks are
 *   always available. In the Manager window, focusedConnectionId is null and
 *   engine will be null — that is acceptable per the spec.
 */

import { useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CommandRegistry } from "@/platform/command-palette/CommandRegistry";
import { useFocusedConnection } from "@/platform/shell/FocusedConnectionContext";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { useToast } from "@/platform/toast";

// ---------------------------------------------------------------------------
// FeedbackHost (exported)
// ---------------------------------------------------------------------------

export function FeedbackHost() {
  const { focusedConnectionId } = useFocusedConnection();
  const { items: connections } = useConnections();
  const toast = useToast();

  const engine: string | null = focusedConnectionId
    ? (connections.find((c) => c.id === focusedConnectionId)?.kind ?? null)
    : null;

  const show = useCallback(() => {
    void invoke("ensure_feedback_window", { engine });
  }, [engine]);

  // Register the command palette entry.
  useEffect(() => {
    const unregister = CommandRegistry.register({
      id: "argus.sendFeedback",
      label: "Send feedback",
      group: "Help",
      keywords: ["bug", "report", "idea", "suggestion", "feedback", "help"],
      run: show,
    });
    return unregister;
  }, [show]);

  // Listen for successful feedback submission from the feedback window
  // and show a toast in the shell (nice-to-have).
  useEffect(() => {
    const unlistenPromise = listen("argus:feedback:submitted", () => {
      toast.show("Feedback sent — thank you!", "success");
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [toast]);

  // FeedbackHost no longer renders any dialog — the feedback window is a
  // dedicated Tauri window opened via ensure_feedback_window.
  return null;
}

// ---------------------------------------------------------------------------
// useFeedback — imperative opener for the shell affordance
// ---------------------------------------------------------------------------

/**
 * Returns a `show` callback that opens the feedback window via
 * `ensure_feedback_window`. The engine is resolved from the focused
 * connection in the current window (null is acceptable when no connection
 * is focused).
 *
 * NOTE: This hook must be called inside AppProviders (which it always is,
 * since FeedbackAffordance lives inside the shell which is wrapped in
 * AppProviders).
 */
export function useFeedback(): { show: () => void } {
  const { focusedConnectionId } = useFocusedConnection();
  const { items: connections } = useConnections();

  const engine: string | null = focusedConnectionId
    ? (connections.find((c) => c.id === focusedConnectionId)?.kind ?? null)
    : null;

  const show = useCallback(() => {
    void invoke("ensure_feedback_window", { engine });
  }, [engine]);

  return { show };
}
