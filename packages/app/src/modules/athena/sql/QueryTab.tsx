/**
 * Athena QueryTab component.
 *
 * Tab kind: "athena-query"
 * Payload: { connectionId, connectionName, initialSql }
 *
 * Renders a CodeMirror SQL editor + resizable result panel.
 * Connection is fixed at open time (no connection selector).
 * Subscribes to schema cache changes for autocomplete reconfiguration.
 * Registers itself with TabRegistry on import.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Bookmark, Lock, Save } from "lucide-react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import type { Tab } from "@/platform/shell/tabs/types";
import { getSetting, setSetting } from "@/platform/settings/api";
import { CommandRegistry } from "@/platform/command-palette";
import { useActiveAthenaConnections } from "../useActiveConnections";
import { athenaSchemaCache } from "../schema/globalSchemaCache";
import { SaveAsModal } from "@/modules/saved-queries/SaveAsModal";
import { contextApi } from "@/modules/context/api";
import { useToast } from "@/platform/toast";
import { QueryEditor, type QueryEditorHandle } from "./QueryEditor";
import { ResultPanel } from "./ResultPanel";
import { useAthenaQueryRun } from "./useQueryRun";
import { useAiReadiness } from "@/modules/ai/useAiReadiness";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { ChatPanel } from "@/modules/ai/components/ChatPanel";
import { useAthenaForm } from "../FormController";
import { athenaApi } from "../api";
import { NamedQueryModal, type NamedQueryModalResult } from "./NamedQueryModal";
import styles from "@/modules/mysql/sql/QueryTab.module.css";

export const ATHENA_QUERY_KIND = "athena-query";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const RUN_HINT = isMac ? "⌘↩" : "Ctrl+↩";
const RUN_ALL_HINT = isMac ? "⌘⇧↩" : "Ctrl+Shift+↩";

/** Debounce window for autocomplete reconfigures triggered by cache updates. */
const RECONFIGURE_DEBOUNCE_MS = 100;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/** Origin describes the NamedQuery a tab was opened from (D4). */
export interface AthenaQueryOrigin {
  namedQueryId: string;
  name: string;
  description?: string;
  database: string;
  workGroup: string;
}

export interface AthenaQueryPayload {
  connectionId: string;
  connectionName: string;
  initialSql: string;
  /** When set, the tab is linked to an existing NamedQuery. */
  origin?: AthenaQueryOrigin;
  /**
   * Used to pre-fill the "Save as Named Query" modal's database field
   * when the tab was opened from a table/view leaf in a known database.
   */
  defaultDatabase?: string;
}

function isPayload(v: unknown): v is AthenaQueryPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.connectionId === "string" &&
    typeof o.connectionName === "string" &&
    typeof o.initialSql === "string"
    // origin and defaultDatabase are optional — backward compatible
  );
}

// ---------------------------------------------------------------------------
// Tab shell — receives Tab + active from TabRegistry
// ---------------------------------------------------------------------------

function AthenaQueryTabRoot({ tab }: { tab: Tab; active: boolean }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.invalid}>Invalid Athena query tab payload.</div>;
  }
  return <AthenaQueryTab tabId={tab.id} payload={tab.payload} />;
}

// ---------------------------------------------------------------------------
// Inner tab
// ---------------------------------------------------------------------------

interface InnerProps {
  tabId: string;
  payload: AthenaQueryPayload;
}

function AthenaQueryTab({ tabId, payload }: InnerProps) {
  const { connectionId, connectionName, initialSql, defaultDatabase } = payload;
  const { getActive } = useActiveAthenaConnections();
  const editorRef = useRef<QueryEditorHandle | null>(null);
  const runner = useAthenaQueryRun();
  const toast = useToast();
  const { items: allConnections } = useConnections();

  const isReadOnly = getActive(connectionId)?.read_only ?? false;

  // -------------------------------------------------------------------------
  // Named-Query origin state (GROUP 4.4):
  //
  // The tabs registry does NOT expose a setPayload/updatePayload method —
  // only setTabTitle and setTabDirty are available. Therefore we hold the
  // resolved `origin` in component-local state. It is seeded from
  // `payload.origin` on mount. After a successful Create, we call setOrigin
  // with the new identity so the toolbar flips to "Update '<name>'" without
  // needing to mutate the registry's immutable payload.
  //
  // Consequence: if the tab is unmounted and remounted (e.g. switched away and
  // back in the same session) the payload.origin is still null/undefined for a
  // tab that was created in the same session; the re-link is session-scoped.
  // This is acceptable per D4 ("small implementation detail").
  // -------------------------------------------------------------------------
  const [origin, setOrigin] = useState<AthenaQueryOrigin | null>(payload.origin ?? null);

  // -------------------------------------------------------------------------
  // AI chat panel state
  // -------------------------------------------------------------------------

  // Readiness: configured provider + available context folder.
  const readiness = useAiReadiness(connectionId);

  // Resolve the active connection + its context_path.
  const currentConnection = allConnections.find((c) => c.id === connectionId) ?? null;
  const contextPath = currentConnection?.context_path ?? null;

  // Open the connection form so the user can link/locate a context folder.
  const { openEdit } = useAthenaForm();
  const handleLinkContext = useCallback(() => {
    if (currentConnection) openEdit(currentConnection);
  }, [openEdit, currentConnection]);

  // Panel open/close state — persisted to localStorage.
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    const stored = localStorage.getItem("argus.ai.panelOpen");
    return stored === "1";
  });

  // Persist panelOpen.
  useEffect(() => {
    localStorage.setItem("argus.ai.panelOpen", panelOpen ? "1" : "0");
  }, [panelOpen]);

  // Listen for the ai.focusChatPanel palette command.
  useEffect(() => {
    function onFocusPanel() {
      setPanelOpen(true);
    }
    window.addEventListener("argus:ai:openPanel", onFocusPanel as EventListener);
    return () => window.removeEventListener("argus:ai:openPanel", onFocusPanel as EventListener);
  }, []);

  // Panel width — persisted to localStorage, clamped to [280, 800].
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const stored = localStorage.getItem("argus.ai.panelWidth");
    const n = stored ? parseInt(stored, 10) : 360;
    return Number.isFinite(n) ? Math.min(800, Math.max(280, n)) : 360;
  });

  // Splitter drag logic.
  const latestWidthRef = useRef(panelWidth);
  latestWidthRef.current = panelWidth;
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleSplitterMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragStartRef.current = { startX: e.clientX, startWidth: latestWidthRef.current };
      e.preventDefault();
      function onMove(ev: MouseEvent) {
        const d = dragStartRef.current;
        if (!d) return;
        const dx = d.startX - ev.clientX;
        const next = Math.min(800, Math.max(280, d.startWidth + dx));
        setPanelWidth(next);
      }
      function onUp() {
        dragStartRef.current = null;
        localStorage.setItem("argus.ai.panelWidth", String(latestWidthRef.current));
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [],
  );

  // Attachable result: only when a single-mode rows result is present.
  const chatAttachableResult =
    runner.state.status === "done" &&
    runner.state.mode === "single" &&
    runner.state.result?.kind === "rows" &&
    runner.state.result.rows.length > 0
      ? {
          columns: runner.state.result.columns.map((c) => c.name),
          rows: runner.state.result.rows,
          truncated: runner.state.result.truncated,
        }
      : null;

  // -------------------------------------------------------------------------
  // Subscribe to schema cache changes and reconfigure autocomplete.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let timer: number | null = null;
    let lastShape = JSON.stringify(athenaSchemaCache.getDatabases(connectionId));
    const unsubscribe = athenaSchemaCache.subscribe(() => {
      const shape = JSON.stringify(athenaSchemaCache.getDatabases(connectionId));
      if (shape === lastShape) return;
      lastShape = shape;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        editorRef.current?.reconfigureAutocomplete();
      }, RECONFIGURE_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [connectionId]);

  // -------------------------------------------------------------------------
  // "Refresh schema" palette command registration.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const unregister = CommandRegistry.register({
      id: `argus.athena.refreshSchemaCache:${tabId}`,
      label: "Athena: Refresh Schema Cache",
      group: "Athena",
      keywords: ["athena", "autocomplete", "schema", "refresh"],
      run: () => {
        athenaSchemaCache.invalidate(connectionId);
        editorRef.current?.reconfigureAutocomplete();
      },
    });
    return () => unregister();
  }, [tabId, connectionId]);

  // -------------------------------------------------------------------------
  // Run handlers
  // -------------------------------------------------------------------------
  const onRun = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const fullSql = ed.getSql();
    const sel = ed.getSelectionRange();
    const cur = ed.getCursor();
    void runner.run({
      connectionId,
      fullSql,
      selectionFrom: sel.from,
      selectionTo: sel.to,
      cursor: cur,
    });
  }, [runner, connectionId]);

  const onRunAll = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const fullSql = ed.getSql();
    void runner.run({
      connectionId,
      fullSql,
      selectionFrom: 0,
      selectionTo: 0,
      cursor: 0,
      forceAll: true,
    });
  }, [runner, connectionId]);

  const onShowInEditor = useCallback((offset: number) => {
    editorRef.current?.setCursor(offset);
  }, []);

  // Clear error mark when results change.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (
      runner.state.status === "done" &&
      runner.state.mode === "single" &&
      runner.state.error?.position != null
    ) {
      const pos = runner.state.error.position;
      const offset = runner.state.startOffset + Math.max(0, pos - 1);
      ed.setErrorMark({ from: offset, to: offset + 1 });
    } else {
      ed.setErrorMark(null);
    }
  }, [runner.state]);

  // -------------------------------------------------------------------------
  // §23.3 — Save query flow (routes to context folder).
  // -------------------------------------------------------------------------
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [defaultSaveFolder, setDefaultSaveFolder] = useState<string | null>(null);
  const [isSavingCtx, setIsSavingCtx] = useState(false);
  // Track context-query name for subsequent saves
  const [contextSavedName, setContextSavedName] = useState<string | null>(null);

  const openSaveAsModal = useCallback(() => {
    getSetting("savedQueries:lastUsedFolder")
      .then((raw) => setDefaultSaveFolder(raw ?? null))
      .catch(() => setDefaultSaveFolder(null));
    setShowSaveAs(true);
  }, []);

  const handleContextSave = useCallback(() => {
    if (contextSavedName) {
      if (isSavingCtx) return;
      setIsSavingCtx(true);
      contextApi
        .saveQuery(connectionId, contextSavedName, editorRef.current?.getSql() ?? "", { mode: "update" })
        .then(() => toast.show("Saved", "success"))
        .catch((e) => toast.show(`Failed to save: ${(e as Error).message ?? String(e)}`, "error"))
        .finally(() => setIsSavingCtx(false));
    } else {
      openSaveAsModal();
    }
  }, [connectionId, contextSavedName, isSavingCtx, openSaveAsModal, toast]);

  const handleSaveAsConfirm = useCallback(
    async ({ name }: { name: string; folderId: string | null }) => {
      const currentSql = editorRef.current?.getSql() ?? "";
      setShowSaveAs(false);
      try {
        await contextApi.saveQuery(connectionId, name, currentSql, { mode: "create" });
        setContextSavedName(name);
        toast.show(`Saved as "${name}"`, "success");
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (msg.includes("already exists")) {
          toast.show(`A query named "${name}" already exists. Choose a different name.`, "error");
          setShowSaveAs(true);
        } else if (msg.includes("has no linked context folder")) {
          toast.show("Link a context folder for this connection to save queries", "info");
        } else {
          toast.show(`Failed to save: ${msg}`, "error");
        }
      }
    },
    [connectionId, toast],
  );

  // -------------------------------------------------------------------------
  // §Named-Query save/update flow (GROUP 4.1 - 4.5).
  // -------------------------------------------------------------------------
  const [showNamedQueryModal, setShowNamedQueryModal] = useState(false);

  // Source the connection's workgroup so the Create modal's workGroup field
  // can be pre-filled. Falls back to "primary" (the Athena default).
  const connectionWorkgroup = (() => {
    const conn = allConnections.find((c) => c.id === connectionId);
    const params = (conn?.params ?? {}) as Record<string, unknown>;
    return typeof params.workgroup === "string" && params.workgroup
      ? params.workgroup
      : "primary";
  })();

  const handleNamedQueryConfirm = useCallback(
    async (result: NamedQueryModalResult) => {
      const currentSql = editorRef.current?.getSql() ?? "";
      setShowNamedQueryModal(false);
      try {
        if (result.mode === "create") {
          const created = await athenaApi.createNamedQuery(
            connectionId,
            result.name,
            currentSql,
            result.database,
            result.workGroup,
            result.description || undefined,
          );
          // Re-link the tab so the next save performs an Update (GROUP 4.4).
          setOrigin({
            namedQueryId: created.named_query_id,
            name: result.name,
            description: result.description || undefined,
            database: created.database,
            workGroup: created.work_group,
          });
          // Invalidate the schema cache so the branch refetches on next expand.
          athenaSchemaCache.invalidate(connectionId);
          toast.show(`Named query "${result.name}" created`, "success");
        } else {
          // Update — origin is guaranteed to be set when mode === "update"
          if (!origin) return;
          await athenaApi.updateNamedQuery(
            connectionId,
            origin.namedQueryId,
            result.name,
            currentSql,
            result.description || undefined,
          );
          // Update local origin state with the new name/description.
          setOrigin((prev) =>
            prev
              ? { ...prev, name: result.name, description: result.description || undefined }
              : prev,
          );
          // Invalidate cache so the branch listing is refreshed.
          athenaSchemaCache.invalidate(connectionId);
          toast.show(`Named query updated`, "success");
        }
      } catch (e) {
        toast.show(`Failed: ${(e as Error).message ?? String(e)}`, "error");
      }
    },
    [connectionId, origin, toast],
  );

  // -------------------------------------------------------------------------
  // Resizable result panel (persisted per tab).
  // -------------------------------------------------------------------------
  const [resultHeight, setResultHeight] = useState(280);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>))) return;
    const key = `athenaQueryResultHeight:${tabId}`;
    getSetting(key)
      .then((raw) => {
        if (raw) {
          const n = Number.parseInt(raw, 10);
          if (Number.isFinite(n) && n >= 120 && n <= 800) setResultHeight(n);
        }
      })
      .catch(() => {});
  }, [tabId]);

  const persistResultHeight = useCallback(
    (h: number) => {
      if (typeof window === "undefined") return;
      if (!("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>))) return;
      setSetting(`athenaQueryResultHeight:${tabId}`, String(h)).catch(() => {});
    },
    [tabId],
  );

  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startH: resultHeight };
      const move = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const delta = dragRef.current.startY - ev.clientY;
        const next = Math.max(120, Math.min(800, dragRef.current.startH + delta));
        setResultHeight(next);
      };
      const up = () => {
        if (dragRef.current) persistResultHeight(resultHeight);
        dragRef.current = null;
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [resultHeight, persistResultHeight],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className={styles.root}>
      {isReadOnly ? (
        <div className={styles.readOnlyBanner}>
          <Lock size={11} />
          Read-only connection — non-SELECT statements will be rejected.
        </div>
      ) : null}

      <div className={styles.editorArea}>
        <div className={styles.editorToolbar}>
          <span className={styles.connectionPill} title={connectionId}>
            {connectionName}
          </span>
          <span className={styles.toolbarDivider} aria-hidden="true" />
          <button
            type="button"
            className={styles.toolbarButton}
            onClick={onRun}
            title={`Run current statement (${RUN_HINT})`}
            disabled={runner.state.status === "running"}
          >
            Run
            <span className={styles.kbd}>{RUN_HINT}</span>
          </button>
          <button
            type="button"
            className={styles.toolbarButton}
            onClick={onRunAll}
            title={`Run all statements (${RUN_ALL_HINT})`}
            disabled={runner.state.status === "running"}
          >
            Run All
            <span className={styles.kbd}>{RUN_ALL_HINT}</span>
          </button>
          <span className={styles.toolbarDivider} aria-hidden="true" />
          {/* ✨ AI chat panel toggle */}
          <button
            type="button"
            className={`${styles.toolbarButton} ${styles.aiButton}`}
            onClick={() => setPanelOpen((prev) => !prev)}
            title={
              readiness.level === "ready"
                ? "Open AI chat panel"
                : readiness.level === "not-configured"
                  ? "Set up AI to start chatting"
                  : "Link a context folder to use AI"
            }
            aria-label="Open AI chat panel"
            aria-pressed={panelOpen}
          >
            <span>✨</span>
            <span>Generate</span>
            <span
              className={`${styles.aiDot} ${
                readiness.level === "ready" ? styles.aiDotReady : styles.aiDotSetup
              }`}
              aria-hidden="true"
            />
          </button>
          <span className={styles.toolbarDivider} aria-hidden="true" />
          <button
            type="button"
            className={styles.toolbarButton}
            onClick={handleContextSave}
            title="Save query"
            aria-label="Save query"
            disabled={isSavingCtx}
          >
            <Save size={11} />
            Save
          </button>
          {/* Named Query Save/Update action (GROUP 4.2–4.3).
              Hidden when read-only per isReadOnly. */}
          {!isReadOnly && (
            <>
              <span className={styles.toolbarDivider} aria-hidden="true" />
              {origin == null ? (
                <button
                  type="button"
                  className={styles.toolbarButton}
                  onClick={() => setShowNamedQueryModal(true)}
                  title="Save as a new Athena Named Query"
                  aria-label="Save as Named Query"
                >
                  <Bookmark size={11} />
                  Save as Named Query
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.toolbarButton}
                  onClick={() => setShowNamedQueryModal(true)}
                  title={`Update named query "${origin.name}"`}
                  aria-label={`Update named query "${origin.name}"`}
                >
                  <Bookmark size={11} />
                  Update &ldquo;{origin.name}&rdquo;
                </button>
              )}
            </>
          )}
        </div>

        <div className={styles.editorRow}>
          <div className={styles.editorWrap}>
            <QueryEditor
              ref={editorRef}
              connectionId={connectionId}
              initialSql={initialSql}
              onChange={() => {}}
              onRun={onRun}
              onRunAll={onRunAll}
            />
          </div>
          {panelOpen ? (
            <>
              <div
                className={styles.splitter}
                role="separator"
                aria-orientation="vertical"
                onMouseDown={handleSplitterMouseDown}
              />
              <div className={styles.chatHost} style={{ width: panelWidth }}>
                <ChatPanel
                  open={true}
                  onClose={() => setPanelOpen(false)}
                  connectionId={connectionId}
                  contextPath={contextPath}
                  readiness={readiness}
                  onLinkContext={handleLinkContext}
                  editorRef={editorRef}
                  result={chatAttachableResult}
                />
              </div>
            </>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        className={styles.handle}
        aria-label="Resize result panel"
        onMouseDown={onHandleMouseDown}
      />

      <div
        className={styles.resultArea}
        style={{ height: resultHeight, flex: `0 0 ${resultHeight}px` }}
      >
        <div className={styles.resultHeader}>
          <span className={styles.connectionLabel}>{connectionName}</span>
          <span className={styles.runSummary}>
            {runner.summary ?? (runner.state.status === "running" ? "Running…" : "")}
          </span>
        </div>
        <div className={styles.resultBody}>
          <ResultPanel
            state={runner.state}
            onShowInEditor={onShowInEditor}
            connectionName={connectionName}
          />
        </div>
      </div>

      <SaveAsModal
        open={showSaveAs}
        defaultName=""
        defaultFolderId={defaultSaveFolder}
        onClose={() => setShowSaveAs(false)}
        onConfirm={(result) => void handleSaveAsConfirm(result)}
      />

      {/* Named Query modal — Create or Update depending on origin state */}
      {showNamedQueryModal && origin == null && (
        <NamedQueryModal
          open={showNamedQueryModal}
          mode="create"
          connectionId={connectionId}
          defaultDatabase={defaultDatabase}
          defaultWorkGroup={connectionWorkgroup}
          onClose={() => setShowNamedQueryModal(false)}
          onConfirm={(result) => void handleNamedQueryConfirm(result)}
        />
      )}
      {showNamedQueryModal && origin != null && (
        <NamedQueryModal
          open={showNamedQueryModal}
          mode="update"
          origin={origin}
          initialName={origin.name}
          initialDescription={origin.description ?? ""}
          onClose={() => setShowNamedQueryModal(false)}
          onConfirm={(result) => void handleNamedQueryConfirm(result)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Register tab kind.
// ---------------------------------------------------------------------------
TabRegistry.register(ATHENA_QUERY_KIND, AthenaQueryTabRoot);
