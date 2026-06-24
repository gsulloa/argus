/**
 * WorkspaceShell — the UI shell for the `workspace` window (Phase 4 + 6).
 *
 * Layout regions (via existing `<Layout>`):
 *   sidebar     = ConnectionRail (40px narrow) + focused connection's tree
 *   center      = ShellMain (command hosts, tabs, palette, etc.)
 *   inspector   = Inspector
 *   statusBar   = StatusBar (keeps VersionIndicator per Decision 3)
 *   bottomPanel = ActivityLogPanel
 *
 * The focused connection is tracked in FocusedConnectionContext (provided by
 * WorkspaceApp above this shell).  The tree column renders ConnectionSubtree
 * for the focused id; if none are open it shows a minimal empty state.
 *
 * Phase 6 lifecycle handlers (all mounted once here):
 *   - workspace:focus-connection → setFocused(id) (idempotent; no-op if same id)
 *   - onCloseRequested → confirm (if >1 open), disconnect-all, show Manager, destroy
 *   - Empty rail (items → 0 after initial load) → getCurrentWindow().close()
 *     which routes through onCloseRequested (0 open → no prompt, no-op disconnect)
 *
 * Shortcuts registered here:
 *   ⌘K / ⌘⇧P   → command palette
 *   ⌘P          → table palette (focused scope)
 *   ⌥⌘P         → table palette (all-open scope)
 *   ⌘W          → close active tab
 *   ⌘\          → toggle inspector
 *   ⌘,          → settings tab
 *   Tab / ⇧Tab  → cycle tabs
 */
import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { Layout } from "@/platform/shell/Layout";
import { Inspector } from "@/platform/shell/Inspector";
import { StatusBar } from "@/platform/shell/StatusBar";
import { ActivityLogPanel } from "@/platform/activity-log/ActivityLogPanel";
import { ShellMain } from "@/app/App";
import { usePalette, useCommandHotkeys, useTablePalette } from "@/platform/command-palette";
import { useShortcuts } from "@/platform/shell/useShortcuts";
import { refreshFocusedConnection } from "@/platform/shell/refreshFocusedConnection";
import { useLayout } from "@/platform/shell/Layout";
import { useTabs, SETTINGS_PLACEHOLDER_KIND, SETTINGS_PLACEHOLDER_TAB_ID } from "@/platform/shell/tabs";
import { SidebarScrollContext } from "@/platform/shell/sidebarScroll";
import { useOpenConnections } from "@/platform/connection-registry/useOpenConnections";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { useConnectionGroups } from "@/platform/connection-registry/useConnectionGroups";
import { ConnectionRail, EngineIcon, deriveEnv, engineLabel } from "./ConnectionRail";
import { ConnectionSubtree } from "./ConnectionSubtree";
import { ConnectionHeaderActions } from "./ConnectionHeaderActions";
import { useFocusedConnection } from "./FocusedConnectionContext";
import { SavedQueriesPanel } from "@/modules/saved-queries/SavedQueriesPanel";
import { useActiveDynamoConnections } from "@/modules/dynamo/useActiveConnections";
import type { DynamoParams } from "@/modules/dynamo/types";
import styles from "./WorkspaceShell.module.css";

// ---------------------------------------------------------------------------
// WorkspaceShell
// ---------------------------------------------------------------------------

export function WorkspaceShell() {
  return (
    <Layout
      sidebar={<WorkspaceSidebar />}
      inspector={<Inspector />}
      statusBar={<StatusBar />}
      bottomPanel={<ActivityLogPanel />}
    >
      <ShellMain />
      <WorkspaceShortcuts />
      <WorkspaceLifecycle />
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// WorkspaceLifecycle — Phase 6 coordination + lifecycle handlers
// ---------------------------------------------------------------------------

/**
 * Mounts three lifecycle effects once for the Workspace window:
 *
 * 1. workspace:focus-connection listener
 *    The Manager emits this after calling workspace_open_connection.  We
 *    call setFocused(id) so the rail selects the newly-opened connection.
 *    Idempotent: calling setFocused with the same id is a visual no-op.
 *
 * 2. onCloseRequested — REWORKED (Task 6.3 + 6.9)
 *    - Re-entrancy guard: if `closingRef.current` is already true a prior
 *      invocation reached destroy(); allow the close through.
 *    - Reads the LIVE open count via `itemsRef` (a ref kept in sync each
 *      render) so the handler never captures a stale closure value.
 *    - If openCount > 1: preventDefault, show a native confirm dialog naming
 *      the count.  Cancel → return (window stays open, connections untouched).
 *    - If openCount ≤ 1: preventDefault so the async disconnect completes
 *      before the window is destroyed.
 *    - Disconnect+close sequence: set closingRef, disconnect_all_connections,
 *      ensure_manager_window, then destroy() to force-close without re-
 *      triggering close-requested.
 *
 * 3. Empty-rail auto-close — RECONCILED (Task 6.9)
 *    When the rail transitions from non-empty → empty and closingRef is false,
 *    call getCurrentWindow().close() (triggers onCloseRequested; with 0 open
 *    there's no prompt, disconnect-all is a no-op, Manager is revealed, window
 *    destroyed).  closingRef prevents a double-close race.
 */
function WorkspaceLifecycle() {
  const { setFocused } = useFocusedConnection();
  const { items, loading, refresh } = useOpenConnections();

  // Re-entrancy guard: set to true once the disconnect+close sequence begins
  // so a re-entrant close-requested event (from destroy()) passes straight
  // through without re-running the handler.
  const closingRef = useRef(false);

  // Mirror of `items` kept up-to-date each render so the close handler reads
  // the live count without capturing a stale closure.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // ------------------------------------------------------------------
  // 1. workspace:focus-connection listener (UNCHANGED)
  //    Re-sync the rail from the backend before focusing.
  // ------------------------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<{ id: string }>("workspace:focus-connection", (event) => {
      // Refresh the open set first, THEN focus — so the just-opened
      // connection is present in `items` before we focus it.
      void refresh().then(() => setFocused(event.payload.id));
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [setFocused, refresh]);

  // ------------------------------------------------------------------
  // 2. onCloseRequested — REWORKED (Tasks 6.3 + 6.9)
  //    Disconnect all connections before the window is destroyed.
  //    Show a confirmation prompt when >1 connection is open.
  // ------------------------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;

    let unlisten: (() => void) | undefined;

    const win = getCurrentWindow();
    win
      .onCloseRequested(async (event) => {
        // Re-entrancy guard: if closingRef is already set a previous invocation
        // already started the disconnect+destroy sequence — let the close through.
        if (closingRef.current) return;

        // Read the LIVE open count from the ref (not from the closure).
        const openCount = itemsRef.current.length;

        if (openCount > 1) {
          // Block the close until the user decides.
          event.preventDefault();

          let confirmed: boolean;
          try {
            confirmed = await confirm(
              `Closing the workspace will disconnect ${openCount} connections. Continue?`,
              { title: "Close workspace", kind: "warning" },
            );
          } catch {
            // Dialog failed (e.g. non-Tauri env); fall back to browser confirm.
            confirmed = window.confirm(
              `Closing the workspace will disconnect ${openCount} connections. Continue?`,
            );
          }

          if (!confirmed) {
            // User cancelled — abort; window stays open, connections untouched.
            return;
          }
        } else {
          // 0 or 1 connection — no prompt, but still preventDefault so the
          // async disconnect can complete before the window is destroyed.
          event.preventDefault();
        }

        // Disconnect+close sequence.
        closingRef.current = true;
        try {
          await invoke("disconnect_all_connections");
        } catch (e) {
          console.error("[argus] WorkspaceLifecycle disconnect_all_connections:", e);
        }
        try {
          await invoke("ensure_manager_window");
        } catch (e) {
          console.error("[argus] WorkspaceLifecycle ensure_manager_window:", e);
        }
        try {
          // Use destroy() to force-close without re-triggering close-requested.
          await getCurrentWindow().destroy();
        } catch (e) {
          console.error("[argus] WorkspaceLifecycle destroy:", e);
        }
      })
      .then((u) => {
        unlisten = u;
      });

    return () => {
      if (unlisten) unlisten();
    };
    // closingRef and itemsRef are refs — stable across renders, no deps needed.
  }, []);

  // ------------------------------------------------------------------
  // 3. Empty-rail auto-close — RECONCILED (Task 6.9)
  //    When the rail transitions from non-empty → empty, call
  //    getCurrentWindow().close() which routes through onCloseRequested.
  //    With 0 open connections there is no prompt, disconnect-all is a
  //    no-op, the Manager is revealed, and the window is destroyed.
  //    The closingRef guard prevents a double-close race if the
  //    disconnect+close sequence from effect #2 is already in flight.
  // ------------------------------------------------------------------
  const hasSeenItems = useRef(false);

  useEffect(() => {
    if (loading) return;

    if (items.length > 0) {
      hasSeenItems.current = true;
      return;
    }

    // items is now 0 — only close if we previously had items (i.e. the last
    // connection was just closed, not the initial empty-before-load state).
    if (!hasSeenItems.current) return;

    // Guard against double-close: if the disconnect+close sequence from
    // effect #2 is already running, skip.
    if (closingRef.current) return;

    // Guard: mark as consumed so a re-render doesn't fire twice.
    hasSeenItems.current = false;

    void (async () => {
      try {
        // Triggers onCloseRequested; with 0 open the handler skips the prompt,
        // calls disconnect_all_connections (no-op), ensure_manager_window, and destroy().
        await getCurrentWindow().close();
      } catch (e) {
        console.error("[argus] WorkspaceLifecycle empty-rail close:", e);
      }
    })();
  }, [items, loading]);

  return null;
}

// ---------------------------------------------------------------------------
// Sidebar: ConnectionRail + tree column
// ---------------------------------------------------------------------------

function WorkspaceSidebar() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { focusedConnectionId } = useFocusedConnection();

  return (
    <div className={styles.sidebarComposite}>
      <ConnectionRail />
      <SidebarScrollContext.Provider value={scrollRef as React.RefObject<HTMLElement>}>
        <div ref={scrollRef} className={styles.treeColumn}>
          {focusedConnectionId ? (
            <>
              <ConnectionIdentityHeader connectionId={focusedConnectionId} />
              <ConnectionSubtree connectionId={focusedConnectionId} />
            </>
          ) : (
            <p className={styles.emptyState}>Open a connection</p>
          )}
          <SavedQueriesPanel />
        </div>
      </SidebarScrollContext.Provider>
    </div>
  );
}

/**
 * ConnectionIdentityHeader — persistent header above the level-2 schema tree
 * showing the focused connection's name, engine, and environment indicator
 * (Decision 11).  Updates reactively on focus change.
 *
 * Task 11.2: when the connection belongs to a group, the display name is
 * formatted as "<group name> - <connection name>".  If the connection has no
 * group_id (or the group cannot be found), only the connection name is shown.
 */
function ConnectionIdentityHeader({ connectionId }: { connectionId: string }) {
  const { items } = useConnections();
  const { items: groups } = useConnectionGroups();
  const { getActive } = useActiveDynamoConnections();
  const connection = items.find((c) => c.id === connectionId);

  if (!connection) return null;

  const env = deriveEnv(connection.name);
  const label = engineLabel(connection.kind);

  // For DynamoDB connections, surface the active AWS region as quiet metadata
  // (issue #184). Prefer the runtime region of the active connection; fall
  // back to the configured params region; otherwise show nothing.
  const dynamoRegion =
    connection.kind === "dynamodb"
      ? (getActive(connection.id)?.region
          ?? (connection.params as unknown as DynamoParams).region
          ?? null)
      : null;

  // Resolve the group name when the connection has a group_id.
  const groupName = connection.group_id
    ? (groups.find((g) => g.id === connection.group_id)?.name ?? null)
    : null;

  // Format: "<group> - <connection>" or just "<connection>" when ungrouped.
  const displayName = groupName
    ? `${groupName} - ${connection.name}`
    : connection.name;

  return (
    <div className={styles.identityHeader}>
      <span className={styles.identityIcon}>
        <EngineIcon kind={connection.kind} />
      </span>
      <span className={styles.identityBody}>
        <span className={styles.identityName} title={displayName}>{displayName}</span>
        <span className={styles.identityMeta}>
          <span className={styles.identityEngine}>{label}</span>
          {dynamoRegion && (
            <span className={styles.identityRegion} title={`AWS region: ${dynamoRegion}`}>
              {dynamoRegion}
            </span>
          )}
          <span
            className={styles.identityEnvDot}
            data-env={env}
            aria-label={env === "prod" ? "production" : "non-production"}
            title={env === "prod" ? "Production" : "Non-production"}
          />
        </span>
      </span>
      <span className={styles.identityActions}>
        <ConnectionHeaderActions connectionId={connectionId} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shortcuts — mirror App.tsx ShortcutBindings exactly (Phase 4 scope)
// ⌥⌘P (all-open) and ⌘P scoping are Phase 7.
// ---------------------------------------------------------------------------

function WorkspaceShortcuts() {
  const palette = usePalette();
  const tablePalette = useTablePalette();
  const { close, activeTabId, cycle, open } = useTabs();
  const { focusedConnectionId } = useFocusedConnection();
  const { items: connections } = useConnections();
  const { toggleInspector } = useLayout();

  // Register command-palette hotkeys (⌘K synonyms via command registry).
  useCommandHotkeys();

  useShortcuts([
    // ⌘R / Ctrl+R → force-reload the focused connection's schema/table tree.
    // useShortcuts calls preventDefault, suppressing the native webview reload.
    // No-op (but still suppressed) when nothing is focused. whenInInput is
    // omitted (false) so it never fires while typing in the SQL editor.
    {
      key: "r",
      handler: () => {
        if (!focusedConnectionId) return;
        const conn = connections.find((c) => c.id === focusedConnectionId);
        if (conn) refreshFocusedConnection(focusedConnectionId, conn.kind);
      },
    },
    // ⌘K → command palette
    { key: "k", whenInInput: true, handler: () => palette.show() },
    // ⌘⇧P → command palette synonym (no collision: shift=true, alt=false)
    { key: "p", shift: true, whenInInput: true, handler: () => palette.show() },
    // ⌘P → table palette, focused scope (Decision 6)
    { key: "p", whenInInput: true, handler: () => tablePalette.show("focused") },
    // ⌥⌘P → table palette, all-open scope (Decision 6)
    { key: "p", alt: true, whenInInput: true, handler: () => tablePalette.show("all-open") },
    // ⌘W → close active tab (within the focused connection's set)
    {
      key: "w",
      whenInInput: true,
      handler: () => {
        if (activeTabId) close(activeTabId);
      },
    },
    // ⌘\ → toggle inspector
    { key: "\\", whenInInput: true, handler: toggleInspector },
    // ⌘, → settings tab in the focused connection's set.
    // If no connection is focused, ⌘, is a no-op in the Workspace (task 5.6).
    {
      key: ",",
      whenInInput: true,
      handler: () => {
        if (!focusedConnectionId) return;
        open({
          id: SETTINGS_PLACEHOLDER_TAB_ID,
          kind: SETTINGS_PLACEHOLDER_KIND,
          title: "Settings",
          payload: null,
        });
      },
    },
    // Tab / ⇧Tab → cycle tabs (within the focused connection's set)
    { key: "Tab", mod: false, handler: () => cycle(1) },
    { key: "Tab", mod: false, shift: true, handler: () => cycle(-1) },
  ]);

  return null;
}
