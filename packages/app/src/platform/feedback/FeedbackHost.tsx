/**
 * FeedbackHost — mounts at the app-shell level (inside ShellMain).
 *
 * Responsibilities:
 *  1. Registers "Send feedback" in the CommandRegistry so the command palette
 *     can open the form (same pattern as AiSettingsHost).
 *  2. Hosts the FeedbackDialog so the Radix focus-trap works correctly.
 *  3. Resolves the active engine type (connection.kind) for the submission
 *     metadata — the engine type string only, never the connection string or
 *     host (e.g. "postgres", "dynamo", "cloudwatch").
 *  4. Listens for the "argus:feedback:open" custom event so the shell
 *     affordance (FeedbackAffordance in StatusBar) can open the form without
 *     prop-drilling.
 *
 * Engine resolution:
 *   Both AppProviders windows (Manager + Workspace) mount
 *   FocusedConnectionProvider and ConnectionsProvider, so these hooks are
 *   always available. In the Manager window, focusedConnectionId is null and
 *   engine will be null — that is acceptable per the spec.
 */

import { useCallback, useEffect, useState } from "react";
import { CommandRegistry } from "@/platform/command-palette/CommandRegistry";
import { useFocusedConnection } from "@/platform/shell/FocusedConnectionContext";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { FeedbackDialog } from "./FeedbackDialog";

// ---------------------------------------------------------------------------
// FeedbackHost (exported)
// ---------------------------------------------------------------------------

export function FeedbackHost() {
  const [open, setOpen] = useState(false);

  // Resolve the active engine type — safe in both Manager and Workspace windows
  // because both mount FocusedConnectionProvider and ConnectionsProvider via
  // AppProviders. In the Manager window, focusedConnectionId is null → engine
  // is null (acceptable per the privacy spec).
  const { focusedConnectionId } = useFocusedConnection();
  const { items: connections } = useConnections();

  const engine: string | null = focusedConnectionId
    ? (connections.find((c) => c.id === focusedConnectionId)?.kind ?? null)
    : null;

  const show = useCallback(() => setOpen(true), []);

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

  // Listen for the custom event emitted by FeedbackAffordance in StatusBar.
  // This avoids prop-drilling while keeping one canonical open-state here.
  useEffect(() => {
    const handler = () => show();
    window.addEventListener("argus:feedback:open", handler);
    return () => window.removeEventListener("argus:feedback:open", handler);
  }, [show]);

  return <FeedbackDialog open={open} onOpenChange={setOpen} engine={engine} />;
}

// ---------------------------------------------------------------------------
// useFeedback — imperative opener for the shell affordance
// ---------------------------------------------------------------------------

/**
 * Returns a `show` callback that opens the FeedbackDialog by dispatching
 * the "argus:feedback:open" custom event. FeedbackHost (mounted in ShellMain)
 * handles the event and flips its open state.
 *
 * This is the same event-dispatch pattern used by the AI chat panel
 * ("argus:ai:openPanel" in AiSettingsHost).
 */
export function useFeedback(): { show: () => void } {
  const show = useCallback(() => {
    window.dispatchEvent(new CustomEvent("argus:feedback:open"));
  }, []);
  return { show };
}
