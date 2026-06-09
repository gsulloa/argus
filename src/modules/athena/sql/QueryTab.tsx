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
import { Lock, Save } from "lucide-react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import type { Tab } from "@/platform/shell/tabs/types";
import { getSetting, setSetting } from "@/platform/settings/api";
import { CommandRegistry } from "@/platform/command-palette";
import { useActiveAthenaConnections } from "../useActiveConnections";
import { athenaSchemaCache } from "../schema/globalSchemaCache";
import { savedQueriesStore } from "@/modules/saved-queries/store";
import { SaveAsModal } from "@/modules/saved-queries/SaveAsModal";
import { useToast } from "@/platform/toast";
import { QueryEditor, type QueryEditorHandle } from "./QueryEditor";
import { ResultPanel } from "./ResultPanel";
import { useAthenaQueryRun } from "./useQueryRun";
import { useAiReadiness } from "@/modules/ai/useAiReadiness";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { ChatPanel } from "@/modules/ai/components/ChatPanel";
import { useAthenaForm } from "../FormController";
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

export interface AthenaQueryPayload {
  connectionId: string;
  connectionName: string;
  initialSql: string;
}

function isPayload(v: unknown): v is AthenaQueryPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.connectionId === "string" &&
    typeof o.connectionName === "string" &&
    typeof o.initialSql === "string"
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
  const { connectionId, connectionName, initialSql } = payload;
  const { getActive } = useActiveAthenaConnections();
  const editorRef = useRef<QueryEditorHandle | null>(null);
  const runner = useAthenaQueryRun();
  const toast = useToast();
  const { items: allConnections } = useConnections();

  const isReadOnly = getActive(connectionId)?.read_only ?? false;

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
  // §23.3 — Save query flow.
  // -------------------------------------------------------------------------
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [defaultSaveFolder, setDefaultSaveFolder] = useState<string | null>(null);

  const openSaveAsModal = useCallback(() => {
    getSetting("savedQueries:lastUsedFolder")
      .then((raw) => setDefaultSaveFolder(raw ?? null))
      .catch(() => setDefaultSaveFolder(null));
    setShowSaveAs(true);
  }, []);

  const handleSaveAsConfirm = useCallback(
    async ({ name, folderId }: { name: string; folderId: string | null }) => {
      const currentSql = editorRef.current?.getSql() ?? "";
      setShowSaveAs(false);
      try {
        await savedQueriesStore.createQuery(folderId, name, currentSql, connectionId);
        if (folderId) {
          setSetting("savedQueries:lastUsedFolder", folderId).catch(() => {});
        }
        toast.show(`Saved as "${name}"`, "success");
      } catch (e) {
        toast.show(`Failed to save: ${(e as Error).message ?? String(e)}`, "error");
      }
    },
    [connectionId, toast],
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
            onClick={openSaveAsModal}
            title="Save query"
            aria-label="Save query"
          >
            <Save size={11} />
            Save
          </button>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Register tab kind.
// ---------------------------------------------------------------------------
TabRegistry.register(ATHENA_QUERY_KIND, AthenaQueryTabRoot);
