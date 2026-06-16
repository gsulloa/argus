/**
 * §20.2 — MS SQL Server QueryTab component.
 *
 * Tab kind: "mssql-query"
 * Payload: { connectionId, connectionName, initialSql }
 *
 * Renders a CodeMirror T-SQL editor + resizable result panel.
 * Pre-warms the bulk columns cache on mount (§22.2).
 * Registers itself with TabRegistry on import.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, RefreshCw, Save, Wand2 } from "lucide-react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import type { Tab } from "@/platform/shell/tabs/types";
import { getSetting, setSetting } from "@/platform/settings/api";
import { CommandRegistry } from "@/platform/command-palette";
import { useActiveMssqlConnections } from "../useActiveConnections";
import { mssqlSchemaCache, isMssqlSystemSchema } from "../schema/globalSchemaCache";
import { mssqlBulkColumnsCache } from "../columns/columnsCache";
import { mssqlApi } from "../api";
import { savedQueriesStore } from "@/modules/saved-queries/store";
import { SaveAsModal } from "@/modules/saved-queries/SaveAsModal";
import { useToast } from "@/platform/toast";
import { ParamStrip } from "@/modules/context/components/ParamStrip";
import { substituteMssqlParams } from "@/modules/context/components/substituteParams";
import type { QueryParam } from "@/modules/context/types";
import { QueryEditor, type QueryEditorHandle } from "./QueryEditor";
import { ResultPanel } from "./ResultPanel";
import { useQueryRun } from "./useQueryRun";
import { ExportMenu } from "./export/ExportMenu";
import type { CellValue } from "../data/types";
import { useAiReadiness } from "@/modules/ai/useAiReadiness";
import { ChatPanel } from "@/modules/ai/components/ChatPanel";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { useMssqlForm } from "../FormController";
import styles from "./QueryTab.module.css";

export const MSSQL_QUERY_KIND = "mssql-query";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const RUN_HINT = isMac ? "⌘↩" : "Ctrl+↩";
const RUN_ALL_HINT = isMac ? "⌘⇧↩" : "Ctrl+Shift+↩";
const FORMAT_HINT = isMac ? "⌘⇧F" : "Ctrl+Shift+F";

/** Debounce window for autocomplete reconfigures triggered by cache updates. */
const RECONFIGURE_DEBOUNCE_MS = 100;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export interface MssqlQueryPayload {
  connectionId: string;
  connectionName: string;
  initialSql: string;
  /**
   * When opening a tab from a context-folder prefab query, the name and
   * declared params are carried here so the tab can render a ParamStrip.
   */
  contextQuery?: {
    name: string;
    params: QueryParam[];
  };
}

function isPayload(v: unknown): v is MssqlQueryPayload {
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

function MssqlQueryTabRoot({ tab }: { tab: Tab; active: boolean }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.invalid}>Invalid MS SQL Server query tab payload.</div>;
  }
  return <MssqlQueryTab tabId={tab.id} payload={tab.payload} />;
}

// ---------------------------------------------------------------------------
// Inner tab
// ---------------------------------------------------------------------------

interface InnerProps {
  tabId: string;
  payload: MssqlQueryPayload;
}

function MssqlQueryTab({ tabId, payload }: InnerProps) {
  const { connectionId, connectionName, initialSql } = payload;
  const { getActive } = useActiveMssqlConnections();
  const editorRef = useRef<QueryEditorHandle | null>(null);
  const runner = useQueryRun();
  const toast = useToast();

  const isReadOnly = getActive(connectionId)?.read_only ?? false;

  // -------------------------------------------------------------------------
  // §22.2 — Pre-warm columns cache on tab open (fire-and-forget).
  // Resolves the default schema via SELECT SCHEMA_NAME() (no extra backend
  // command needed), then fetches bulk columns for that schema.
  // Respects useVisibleSchemas: skips system schemas.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await mssqlApi.runSql(connectionId, "SELECT SCHEMA_NAME() AS s", "auto");
        if (cancelled) return;
        if (
          result.kind === "rows" &&
          result.rows[0] &&
          result.rows[0][0] != null
        ) {
          const defaultSchema = String(result.rows[0][0]);
          // Skip system schemas.
          if (isMssqlSystemSchema(defaultSchema)) return;
          if (!mssqlBulkColumnsCache.isPopulatedOrInFlight(connectionId, defaultSchema)) {
            mssqlBulkColumnsCache.refresh(connectionId, defaultSchema, "auto").catch(() => {});
          }
          setCurrentSchema(defaultSchema);
        }
      } catch {
        // Fire-and-forget; do not block editor mount.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  // -------------------------------------------------------------------------
  // §22.3 — Current schema for refresh command
  // -------------------------------------------------------------------------
  const [currentSchema, setCurrentSchema] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // §22.3 — "Refresh columns" palette command registration.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const unregister = CommandRegistry.register({
      id: `argus.mssql.refreshColumnsCache:${tabId}`,
      label: "MS SQL Server: Refresh Columns Cache",
      group: "MS SQL Server",
      keywords: ["mssql", "autocomplete", "columns", "refresh", "sql server"],
      run: () => {
        if (!currentSchema) return;
        mssqlBulkColumnsCache.invalidate(connectionId, currentSchema);
        mssqlBulkColumnsCache.refresh(connectionId, currentSchema, "user").catch(() => {});
      },
    });
    return () => unregister();
  }, [tabId, connectionId, currentSchema]);

  // -------------------------------------------------------------------------
  // Subscribe to schema cache changes and reconfigure autocomplete.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let timer: number | null = null;
    let lastShape = JSON.stringify(mssqlSchemaCache.getSchemas(connectionId));
    const unsubscribe = mssqlSchemaCache.subscribe(() => {
      const shape = JSON.stringify(mssqlSchemaCache.getSchemas(connectionId));
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

  // -------------------------------------------------------------------------
  // §20.10 — Format SQL handler (T-SQL formatter via sql-formatter).
  // -------------------------------------------------------------------------
  const onFormat = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    try {
      ed.formatBuffer();
    } catch (e) {
      console.error("[argus.mssql.format]", e);
      toast.show("Could not format SQL", "error");
    }
  }, [toast]);

  // §20.5 — Set error mark when a single-run error with a line is returned.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (
      runner.state.status === "done" &&
      runner.state.mode === "single" &&
      runner.state.error?.line != null
    ) {
      // Line is 1-based and relative to the batch start; jump to the
      // beginning of the batch + line offset.
      const batchStart = runner.state.startOffset;
      const line = runner.state.error.line;
      // Walk forward (line-1) newlines from batchStart.
      const sql = ed.getSql();
      let offset = batchStart;
      let linesLeft = line - 1;
      while (linesLeft > 0 && offset < sql.length) {
        if (sql[offset] === "\n") linesLeft--;
        offset++;
      }
      ed.setErrorMark({ from: offset, to: offset + 1 });
    } else {
      ed.setErrorMark(null);
    }
  }, [runner.state]);

  // -------------------------------------------------------------------------
  // §22.3 — Refresh columns button handler
  // -------------------------------------------------------------------------
  const handleRefreshColumns = useCallback(() => {
    if (!currentSchema) return;
    mssqlBulkColumnsCache.invalidate(connectionId, currentSchema);
    mssqlBulkColumnsCache.refresh(connectionId, currentSchema, "user").catch(() => {});
  }, [connectionId, currentSchema]);

  // -------------------------------------------------------------------------
  // Context-query param strip
  // -------------------------------------------------------------------------

  // Initialise param values from defaults.
  const [paramValues, setParamValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    if (payload.contextQuery) {
      for (const p of payload.contextQuery.params) {
        init[p.name] = p.default !== null && p.default !== undefined ? String(p.default) : "";
      }
    }
    return init;
  });

  const handleParamChange = useCallback((name: string, value: string) => {
    setParamValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  // Names of required params (no default) that are currently empty.
  const missingRequired = payload.contextQuery
    ? payload.contextQuery.params
        .filter(
          (p) =>
            (p.default === null || p.default === undefined) &&
            (paramValues[p.name] ?? "").trim() === "",
        )
        .map((p) => p.name)
    : [];

  // "Insert into editor": substitute @name params and write the result into the editor.
  // CRITICAL: uses substituteMssqlParams (not substitutePostgresParams) — MSSQL uses @name.
  const handleInsertIntoEditor = useCallback(() => {
    if (!payload.contextQuery) return;
    const ed = editorRef.current;
    if (!ed) return;
    const body = payload.initialSql;
    const substituted = substituteMssqlParams(
      body,
      payload.contextQuery.params.map((p) => ({
        name: p.name,
        value: paramValues[p.name] ?? "",
      })),
    );
    ed.replaceBody(substituted);
  }, [payload.contextQuery, payload.initialSql, paramValues]);

  // -------------------------------------------------------------------------
  // Save query flow.
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
  // AI chat panel state.
  // Mirrors the Postgres QueryTab wiring; the AI backend is engine-agnostic
  // (it works off the cross-engine context folder), so the only engine-specific
  // piece is sourcing connectionId/context_path here.
  // -------------------------------------------------------------------------
  const { items: allConnections } = useConnections();
  const { openEdit } = useMssqlForm();

  // Single derived readiness state (provider + context folder) driving the
  // button dot, the panel mode, and chat gating.
  const readiness = useAiReadiness(connectionId);

  // Resolve the active connection + its context_path.
  const currentConnection =
    allConnections.find((c) => c.id === connectionId) ?? null;
  const contextPath = currentConnection?.context_path ?? null;

  // Open the connection form so the user can link/locate a context folder.
  const handleLinkContext = useCallback(() => {
    if (currentConnection) openEdit(currentConnection);
  }, [openEdit, currentConnection]);

  // Live executed result available to attach into the AI chat as context.
  const chatAttachableResult =
    runner.state.status === "done" &&
    runner.state.mode === "single" &&
    runner.state.result?.kind === "rows" &&
    runner.state.result.rows.length > 0
      ? {
          columns: runner.state.result.columns.map((c) => c.name),
          rows: runner.state.result.rows as CellValue[][],
          truncated: runner.state.result.truncated,
        }
      : null;

  // Panel width — persisted to localStorage, clamped to [280, 800].
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const stored = localStorage.getItem("argus.ai.panelWidth");
    const n = stored ? parseInt(stored, 10) : 360;
    return Number.isFinite(n) ? Math.min(800, Math.max(280, n)) : 360;
  });

  // Panel open state — persisted to localStorage (shared with other SQL editors).
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    const stored = localStorage.getItem("argus.ai.panelOpen");
    return stored === "1";
  });

  // Listen for the ai.focusChatPanel palette command — always opens the panel.
  useEffect(() => {
    function onFocusPanel() {
      setPanelOpen(true);
    }
    window.addEventListener("argus:ai:openPanel", onFocusPanel as EventListener);
    return () => window.removeEventListener("argus:ai:openPanel", onFocusPanel as EventListener);
  }, []);

  // Persist panelOpen to localStorage.
  useEffect(() => {
    localStorage.setItem("argus.ai.panelOpen", panelOpen ? "1" : "0");
  }, [panelOpen]);

  // Splitter drag logic.
  const latestWidthRef = useRef(panelWidth);
  latestWidthRef.current = panelWidth;
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    dragStartRef.current = { startX: e.clientX, startWidth: latestWidthRef.current };
    e.preventDefault();
    function onMove(ev: MouseEvent) {
      const d = dragStartRef.current;
      if (!d) return;
      // Dragging left increases panel width (panel is on the right).
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
  }, []);

  // -------------------------------------------------------------------------
  // Resizable result panel (persisted per tab).
  // -------------------------------------------------------------------------
  const [resultHeight, setResultHeight] = useState(280);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>))) return;
    const key = `mssqlQueryResultHeight:${tabId}`;
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
      setSetting(`mssqlQueryResultHeight:${tabId}`, String(h)).catch(() => {});
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
          <button
            type="button"
            className={styles.toolbarButton}
            onClick={handleRefreshColumns}
            title="Refresh columns autocomplete"
            disabled={!currentSchema}
          >
            <RefreshCw size={11} />
            Refresh Columns
          </button>
          <span className={styles.toolbarDivider} aria-hidden="true" />
          <button
            type="button"
            className={styles.toolbarButton}
            onClick={onFormat}
            title={`Format SQL (${FORMAT_HINT})`}
          >
            <Wand2 size={11} />
            Format
            <span className={styles.kbd}>{FORMAT_HINT}</span>
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
          <span className={styles.toolbarDivider} aria-hidden="true" />
          {/* Generate button — always rendered; status dot reflects readiness */}
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
        </div>

        {payload.contextQuery && payload.contextQuery.params.length > 0 && (
          <ParamStrip
            params={payload.contextQuery.params}
            values={paramValues}
            onChange={handleParamChange}
            onInsert={handleInsertIntoEditor}
            missingRequired={missingRequired}
          />
        )}

        <div className={styles.editorRow}>
          <div className={styles.editorWrap}>
            <QueryEditor
              ref={editorRef}
              connectionId={connectionId}
              initialSql={initialSql}
              onChange={() => {}}
              onRun={onRun}
              onRunAll={onRunAll}
              onFormat={onFormat}
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
          {runner.state.status === "done" &&
          runner.state.mode === "single" &&
          runner.state.result?.kind === "rows" &&
          runner.state.result.rows.length > 0 ? (
            <ExportMenu
              connectionName={connectionName}
              columns={runner.state.result.columns}
              rows={runner.state.result.rows as CellValue[][]}
              truncated={runner.state.result.truncated}
            />
          ) : null}
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
TabRegistry.register(MSSQL_QUERY_KIND, MssqlQueryTabRoot);
