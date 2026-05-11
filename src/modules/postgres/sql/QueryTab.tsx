import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, Wand2 } from "lucide-react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import type { Tab } from "@/platform/shell/tabs/types";
import { getSetting, setSetting } from "@/platform/settings/api";
import { useToast } from "@/platform/toast";
import { useActiveConnections } from "../useActiveConnections";
import { globalSchemaCache } from "../schema/globalSchemaCache";
import { QueryEditor, type QueryEditorHandle } from "./QueryEditor";
import { ResultPanel } from "./ResultPanel";
import { ExportMenu } from "./export/ExportMenu";
import { RunSummary } from "./RunSummary";
import { useQueryBuffer } from "./useQueryBuffer";
import { useQueryRun } from "./useQueryRun";
import styles from "./QueryTab.module.css";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const FORMAT_HINT = isMac ? "⌘⇧F" : "Ctrl+Shift+F";

/** Debounce window for autocomplete reconfigures triggered by cache updates. */
const RECONFIGURE_DEBOUNCE_MS = 100;

export const POSTGRES_QUERY_KIND = "postgres-query";

export interface PostgresQueryPayload {
  connectionId: string;
  connectionName: string;
  sql: string;
}

function isPayload(v: unknown): v is PostgresQueryPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.connectionId === "string" &&
    typeof o.connectionName === "string" &&
    typeof o.sql === "string"
  );
}

function QueryTabRoot({ tab }: { tab: Tab; active: boolean }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.invalid}>Invalid query tab payload.</div>;
  }
  return (
    <QueryTab tabId={tab.id} payload={tab.payload} />
  );
}

interface InnerProps {
  tabId: string;
  payload: PostgresQueryPayload;
}

function QueryTab({ tabId, payload }: InnerProps) {
  const { getActive } = useActiveConnections();
  const isReadOnly = getActive(payload.connectionId)?.read_only ?? false;
  const toast = useToast();

  const buffer = useQueryBuffer(tabId, payload.sql);
  const editorRef = useRef<QueryEditorHandle | null>(null);
  const runner = useQueryRun(payload.connectionId);

  // Subscribe to the schema cache and re-bind the editor's autocomplete
  // sources whenever the namespace shape changes. Debounced so a burst of
  // cache writes (e.g., bulk fetch landing) only triggers one reconfigure.
  useEffect(() => {
    let timer: number | null = null;
    let lastShape = globalSchemaCache.namespaceShapeKey(payload.connectionId);
    const unsubscribe = globalSchemaCache.subscribe(() => {
      const shape = globalSchemaCache.namespaceShapeKey(payload.connectionId);
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
  }, [payload.connectionId]);

  const onRun = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const fullSql = ed.getSql();
    const sel = ed.getSelectionRange();
    const cur = ed.getCursor();
    void runner.run({
      fullSql,
      selectionFrom: sel.from,
      selectionTo: sel.to,
      cursor: cur,
    });
  }, [runner]);

  const onRunAll = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const fullSql = ed.getSql();
    void runner.run({
      fullSql,
      selectionFrom: 0,
      selectionTo: 0,
      cursor: 0,
      forceAll: true,
    });
  }, [runner]);

  const onShowInEditor = useCallback((offset: number) => {
    editorRef.current?.setCursor(offset);
  }, []);

  const onFormat = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    try {
      ed.formatBuffer();
    } catch (e) {
      console.error("[argus.sql.format]", e);
      toast.show("Could not format SQL", "error");
    }
  }, [toast]);

  // Resizable result panel.
  const [resultHeight, setResultHeight] = useState(280);
  useEffect(() => {
    // Read persisted height once.
    if (typeof window === "undefined") return;
    if (!("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>))) return;
    const key = `pgQueryResultHeight:${tabId}`;
    getSetting(key)
      .then((raw) => {
        if (raw) {
          const n = Number.parseInt(raw, 10);
          if (Number.isFinite(n) && n >= 120 && n <= 800) {
            setResultHeight(n);
          }
        }
      })
      .catch(() => {});
  }, [tabId]);
  const persistResultHeight = useCallback(
    (h: number) => {
      if (typeof window === "undefined") return;
      if (!("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>))) return;
      setSetting(`pgQueryResultHeight:${tabId}`, String(h)).catch(() => {});
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
          <button
            type="button"
            className={styles.toolbarButton}
            onClick={onFormat}
            title={`Format SQL (${FORMAT_HINT})`}
          >
            <Wand2 size={12} />
            <span>Format</span>
            <span className={styles.kbd}>{FORMAT_HINT}</span>
          </button>
        </div>
        {buffer.loaded ? (
          <QueryEditor
            ref={editorRef}
            connectionId={payload.connectionId}
            initialSql={buffer.initialSql}
            onChange={buffer.update}
            onRun={onRun}
            onRunAll={onRunAll}
            onFormat={onFormat}
          />
        ) : (
          <div className={styles.editorPlaceholder}>Loading editor…</div>
        )}
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
          <span className={styles.connectionLabel}>{payload.connectionName}</span>
          <span className={styles.runSummary}>
            <RunSummary
              staticSummary={runner.summary}
              runStartedAt={runner.runStartedAt}
              isRunning={runner.state.status === "running"}
            />
          </span>
          {runner.state.status === "done" &&
          runner.state.mode === "single" &&
          runner.state.result?.kind === "rows" &&
          runner.state.result.rows.length > 0 ? (
            <ExportMenu
              connectionName={payload.connectionName}
              columns={runner.state.result.columns}
              rows={runner.state.result.rows}
              truncated={runner.state.result.truncated}
            />
          ) : null}
        </div>
        <div className={styles.resultBody}>
          <ResultPanel state={runner.state} onShowInEditor={onShowInEditor} />
        </div>
      </div>
    </div>
  );
}

TabRegistry.register(POSTGRES_QUERY_KIND, QueryTabRoot);
