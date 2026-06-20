/**
 * DynamoDB PartiQL QueryTab component.
 *
 * Tab kind: "dynamo-query"
 * Payload: { connectionId, connectionName, initialPartiql? }
 *
 * Renders a CodeMirror PartiQL editor + resizable result panel.
 * Subscribes to the DynamoDB tables cache for autocomplete reconfiguration.
 * Registers itself with TabRegistry on import.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import type { Tab } from "@/platform/shell/tabs/types";
import { getSetting, setSetting } from "@/platform/settings/api";
import { useActiveDynamoConnections } from "../useActiveConnections";
import { useDynamoTableCache } from "../tables/CacheProvider";
import type { TableDescription } from "../tables/types";
import { registerTableCache } from "./completionSources";
import { QueryEditor, type QueryEditorHandle } from "./QueryEditor";
import { ResultPanel } from "./ResultPanel";
import { useDynamoQueryRun } from "./useQueryRun";
import styles from "@/modules/mysql/sql/QueryTab.module.css";

export const DYNAMO_QUERY_KIND = "dynamo-query";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const RUN_HINT = isMac ? "⌘↩" : "Ctrl+↩";
const RUN_ALL_HINT = isMac ? "⌘⇧↩" : "Ctrl+Shift+↩";

/** Debounce window for autocomplete reconfigures triggered by cache updates. */
const RECONFIGURE_DEBOUNCE_MS = 100;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export interface DynamoQueryPayload {
  connectionId: string;
  connectionName: string;
  initialPartiql?: string;
}

function isPayload(v: unknown): v is DynamoQueryPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.connectionId === "string" &&
    typeof o.connectionName === "string"
  );
}

// ---------------------------------------------------------------------------
// Tab shell — receives Tab + active from TabRegistry
// ---------------------------------------------------------------------------

function DynamoQueryTabRoot({ tab }: { tab: Tab; active: boolean }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.invalid}>Invalid DynamoDB PartiQL tab payload.</div>;
  }
  return <DynamoQueryTab tabId={tab.id} payload={tab.payload} />;
}

// ---------------------------------------------------------------------------
// Inner tab
// ---------------------------------------------------------------------------

interface InnerProps {
  tabId: string;
  payload: DynamoQueryPayload;
}

function DynamoQueryTab({ tabId, payload }: InnerProps) {
  const { connectionId, connectionName, initialPartiql = "" } = payload;
  const { getActive } = useActiveDynamoConnections();
  const editorRef = useRef<QueryEditorHandle | null>(null);
  const runner = useDynamoQueryRun();

  const isReadOnly = getActive(connectionId)?.read_only ?? false;

  // -------------------------------------------------------------------------
  // Subscribe to the DynamoDB tables cache and feed completion sources.
  // -------------------------------------------------------------------------
  const tableCache = useDynamoTableCache(connectionId);

  useEffect(() => {
    let timer: number | null = null;
    const tableNames =
      tableCache.tables.status === "ready" ? tableCache.tables.names : [];
    // Build a Map<string, TableDescription> from the DescribeSlot cache,
    // filtering to only "ready" slots.
    const descriptions = new Map<string, TableDescription>();
    for (const [name, slot] of tableCache.describe.entries()) {
      if (slot.status === "ready") {
        descriptions.set(name, slot.value);
      }
    }
    registerTableCache(connectionId, tableNames, descriptions);
    timer = window.setTimeout(() => {
      editorRef.current?.reconfigureAutocomplete();
    }, RECONFIGURE_DEBOUNCE_MS);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [connectionId, tableCache.tables, tableCache.describe]);

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
  // Resizable result panel (persisted per tab).
  // -------------------------------------------------------------------------
  const [resultHeight, setResultHeight] = useState(280);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>))) return;
    const key = `dynamoQueryResultHeight:${tabId}`;
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
      setSetting(`dynamoQueryResultHeight:${tabId}`, String(h)).catch(() => {});
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
          Read-only connection — INSERT/UPDATE/DELETE statements will be rejected.
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
        </div>

        <div className={styles.editorRow}>
          <div className={styles.editorWrap}>
            <QueryEditor
              ref={editorRef}
              connectionId={connectionId}
              initialSql={initialPartiql}
              onChange={() => {}}
              onRun={onRun}
              onRunAll={onRunAll}
            />
          </div>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Register tab kind.
// ---------------------------------------------------------------------------
TabRegistry.register(DYNAMO_QUERY_KIND, DynamoQueryTabRoot);
