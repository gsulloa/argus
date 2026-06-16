/**
 * §20.2 — MySQL QueryTab component.
 *
 * Tab kind: "mysql-query"
 * Payload: { connectionId, connectionName, initialSql }
 *
 * Renders a CodeMirror SQL editor + resizable result panel.
 * Connection is fixed at open time (unlike Postgres, no connection selector).
 * Pre-warms the bulk columns cache on mount (§22.2).
 * Registers itself with TabRegistry on import.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, RefreshCw, Save } from "lucide-react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import type { Tab } from "@/platform/shell/tabs/types";
import { getSetting, setSetting } from "@/platform/settings/api";
import { CommandRegistry } from "@/platform/command-palette";
import { useActiveMysqlConnections } from "../useActiveConnections";
import { mysqlSchemaCache } from "../schema/globalSchemaCache";
import { mysqlBulkColumnsCache } from "./columnsCache";
import { mysqlApi } from "../api";
import { savedQueriesStore } from "@/modules/saved-queries/store";
import { SaveAsModal } from "@/modules/saved-queries/SaveAsModal";
import { useToast } from "@/platform/toast";
import { QueryEditor, type QueryEditorHandle } from "./QueryEditor";
import { ResultPanel } from "./ResultPanel";
import { useQueryRun } from "./useQueryRun";
import { ExportMenu } from "./export/ExportMenu";
import { ParamStrip } from "@/modules/context/components/ParamStrip";
import { substitutePostgresParams } from "@/modules/context/components/substituteParams";
import type { QueryParam } from "@/modules/context/types";
import type { CellValue } from "../data/types";
import styles from "./QueryTab.module.css";

export const MYSQL_QUERY_KIND = "mysql-query";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const RUN_HINT = isMac ? "⌘↩" : "Ctrl+↩";
const RUN_ALL_HINT = isMac ? "⌘⇧↩" : "Ctrl+Shift+↩";

/** Debounce window for autocomplete reconfigures triggered by cache updates. */
const RECONFIGURE_DEBOUNCE_MS = 100;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export interface MysqlQueryPayload {
  connectionId: string;
  connectionName: string;
  initialSql: string;
  /**
   * When opening a tab from a context-folder prefab query, this carries the
   * query's name and declared params so the tab renders a ParamStrip.
   */
  contextQuery?: {
    name: string;
    params: QueryParam[];
  };
}

function isPayload(v: unknown): v is MysqlQueryPayload {
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

function MysqlQueryTabRoot({ tab }: { tab: Tab; active: boolean }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.invalid}>Invalid MySQL query tab payload.</div>;
  }
  return <MysqlQueryTab tabId={tab.id} payload={tab.payload} />;
}

// ---------------------------------------------------------------------------
// Inner tab
// ---------------------------------------------------------------------------

interface InnerProps {
  tabId: string;
  payload: MysqlQueryPayload;
}

function MysqlQueryTab({ tabId, payload }: InnerProps) {
  const { connectionId, connectionName, initialSql } = payload;
  const { getActive } = useActiveMysqlConnections();
  const editorRef = useRef<QueryEditorHandle | null>(null);
  const runner = useQueryRun();
  const toast = useToast();

  const isReadOnly = getActive(connectionId)?.read_only ?? false;

  // -------------------------------------------------------------------------
  // §22.2 — Pre-warm columns cache on tab open (fire-and-forget).
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await mysqlApi.runSql(connectionId, "SELECT DATABASE()", "auto");
        if (cancelled) return;
        if (
          result.kind === "rows" &&
          result.rows[0] &&
          result.rows[0][0] != null
        ) {
          const defaultSchema = String(result.rows[0][0]);
          if (!mysqlBulkColumnsCache.isPopulatedOrInFlight(connectionId, defaultSchema)) {
            mysqlBulkColumnsCache.refresh(connectionId, defaultSchema, "auto").catch(() => {});
          }
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
  // §22.3 — "Refresh columns" palette command registration.
  // -------------------------------------------------------------------------
  const [currentSchema, setCurrentSchema] = useState<string | null>(null);

  useEffect(() => {
    // Resolve current schema for the refresh command.
    mysqlApi
      .runSql(connectionId, "SELECT DATABASE()", "auto")
      .then((result) => {
        if (
          result.kind === "rows" &&
          result.rows[0] &&
          result.rows[0][0] != null
        ) {
          setCurrentSchema(String(result.rows[0][0]));
        }
      })
      .catch(() => {});
  }, [connectionId]);

  useEffect(() => {
    const unregister = CommandRegistry.register({
      id: `argus.mysql.refreshColumnsCache:${tabId}`,
      label: "MySQL: Refresh Columns Cache",
      group: "MySQL",
      keywords: ["mysql", "autocomplete", "columns", "refresh"],
      run: () => {
        if (!currentSchema) return;
        mysqlBulkColumnsCache.invalidate(connectionId, currentSchema);
        mysqlBulkColumnsCache.refresh(connectionId, currentSchema, "user").catch(() => {});
      },
    });
    return () => unregister();
  }, [tabId, connectionId, currentSchema]);

  // -------------------------------------------------------------------------
  // Subscribe to schema cache changes and reconfigure autocomplete.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let timer: number | null = null;
    let lastShape = JSON.stringify(mysqlSchemaCache.getSchemas(connectionId));
    const unsubscribe = mysqlSchemaCache.subscribe(() => {
      const shape = JSON.stringify(mysqlSchemaCache.getSchemas(connectionId));
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
  // §22.3 — Refresh columns button handler
  // -------------------------------------------------------------------------
  const handleRefreshColumns = useCallback(() => {
    if (!currentSchema) return;
    mysqlBulkColumnsCache.invalidate(connectionId, currentSchema);
    mysqlBulkColumnsCache.refresh(connectionId, currentSchema, "user").catch(() => {});
  }, [connectionId, currentSchema]);

  // -------------------------------------------------------------------------
  // Context-query param strip (§10.5 / §10.6)
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

  // "Insert into editor": substitute params (MySQL uses :name — same as Postgres) and write into the editor.
  const handleInsertIntoEditor = useCallback(() => {
    if (!payload.contextQuery) return;
    const ed = editorRef.current;
    if (!ed) return;
    const body = payload.initialSql;
    const substituted = substitutePostgresParams(
      body,
      payload.contextQuery.params.map((p) => ({
        name: p.name,
        value: paramValues[p.name] ?? "",
      })),
    );
    ed.replaceBody(substituted);
  }, [payload.contextQuery, payload.initialSql, paramValues]);

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
    const key = `mysqlQueryResultHeight:${tabId}`;
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
      setSetting(`mysqlQueryResultHeight:${tabId}`, String(h)).catch(() => {});
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
            onClick={openSaveAsModal}
            title="Save query"
            aria-label="Save query"
          >
            <Save size={11} />
            Save
          </button>
        </div>

        {payload.contextQuery && (
          <ParamStrip
            params={payload.contextQuery.params}
            values={paramValues}
            onChange={handleParamChange}
            onInsert={handleInsertIntoEditor}
            missingRequired={missingRequired}
          />
        )}

        <QueryEditor
          ref={editorRef}
          connectionId={connectionId}
          initialSql={initialSql}
          onChange={() => {}}
          onRun={onRun}
          onRunAll={onRunAll}
        />
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
TabRegistry.register(MYSQL_QUERY_KIND, MysqlQueryTabRoot);
