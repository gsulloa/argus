/**
 * CloudWatch Logs Insights QueryTab.
 *
 * Tab kind: "cloudwatch-insights"
 * Payload: { connectionId, connectionName, initialGroups?, initialQuery? }
 *
 * Renders:
 *  - InsightsToolbar (log-group multi-select + time-range picker)
 *  - QueryEditor (CodeMirror .cwlogs)
 *  - ResultPanel (virtualized read-only grid over dynamic columns)
 *
 * Registers itself with TabRegistry on import.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import type { Tab } from "@/platform/shell/tabs/types";
import { InsightsToolbar } from "./Toolbar";
import { QueryEditor, type QueryEditorHandle } from "./QueryEditor";
import { InsightsResultPanel } from "./ResultPanel";
import { useInsightsQueryRun } from "./useQueryRun";
import { useAiReadiness } from "@/modules/ai/useAiReadiness";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { ChatPanel } from "@/modules/ai/components/ChatPanel";
import { useCloudwatchForm } from "../FormController";
import type { TimeRange } from "../types";
import styles from "@/modules/mysql/sql/QueryTab.module.css";

export const CLOUDWATCH_INSIGHTS_KIND = "cloudwatch-insights";

const DEFAULT_TIME_RANGE: TimeRange = { kind: "relative", preset: "1h" };
const DEFAULT_QUERY = "fields @timestamp, @message\n| sort @timestamp desc\n| limit 100";

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export interface InsightsTabPayload {
  connectionId: string;
  connectionName: string;
  initialGroups?: string[];
  initialQuery?: string;
}

function isPayload(v: unknown): v is InsightsTabPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.connectionId === "string" &&
    typeof o.connectionName === "string"
  );
}

// ---------------------------------------------------------------------------
// Tab shell
// ---------------------------------------------------------------------------

function InsightsTabRoot({ tab }: { tab: Tab; active: boolean }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.invalid}>Invalid CloudWatch Insights tab payload.</div>;
  }
  return <InsightsTabInner payload={tab.payload} />;
}

// ---------------------------------------------------------------------------
// Inner tab
// ---------------------------------------------------------------------------

interface InnerProps {
  payload: InsightsTabPayload;
}

function InsightsTabInner({ payload }: InnerProps) {
  const { connectionId, connectionName, initialGroups = [], initialQuery = DEFAULT_QUERY } = payload;
  const editorRef = useRef<QueryEditorHandle | null>(null);
  const runner = useInsightsQueryRun();

  const [selectedGroups, setSelectedGroups] = useState<string[]>(initialGroups);
  const [timeRange, setTimeRange] = useState<TimeRange>(DEFAULT_TIME_RANGE);

  // -------------------------------------------------------------------------
  // AI chat panel state
  // -------------------------------------------------------------------------

  // Readiness: provider alone is sufficient for CloudWatch (context-optional).
  const readiness = useAiReadiness(connectionId, { contextOptional: true });

  // Resolve the active connection + its context_path.
  const { items: allConnections } = useConnections();
  const currentConnection = allConnections.find((c) => c.id === connectionId) ?? null;
  const contextPath = currentConnection?.context_path ?? null;

  // Open the connection form so the user can link/locate a context folder.
  const { openEdit } = useCloudwatchForm();
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
  const splitterDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleSplitterMouseDown = useCallback(
    (e: React.MouseEvent) => {
      splitterDragRef.current = { startX: e.clientX, startWidth: latestWidthRef.current };
      e.preventDefault();
      function onMove(ev: MouseEvent) {
        const d = splitterDragRef.current;
        if (!d) return;
        const dx = d.startX - ev.clientX;
        const next = Math.min(800, Math.max(280, d.startWidth + dx));
        setPanelWidth(next);
      }
      function onUp() {
        splitterDragRef.current = null;
        localStorage.setItem("argus.ai.panelWidth", String(latestWidthRef.current));
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [],
  );

  // Attachable result: available when the run returned at least one row.
  // InsightsRunState has status "idle"|"running" (no "done"); result is set
  // after a successful run while status returns to "idle".
  const chatAttachableResult =
    runner.state.result?.kind === "rows" && runner.state.result.rows.length > 0
      ? {
          columns: runner.state.result.columns.map((c) => c.name),
          rows: runner.state.result.rows,
          truncated: runner.state.result.truncated,
        }
      : null;

  // -------------------------------------------------------------------------
  // Resizable result panel
  // -------------------------------------------------------------------------
  const [resultHeight, setResultHeight] = useState(280);
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
        dragRef.current = null;
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [resultHeight],
  );

  const handleRun = useCallback(() => {
    const query = editorRef.current?.getQuery() ?? "";
    void runner.run({
      connectionId,
      logGroupIdentifiers: selectedGroups,
      timeRange,
      queryString: query,
    });
  }, [runner, connectionId, selectedGroups, timeRange]);

  const handleCancel = useCallback(() => {
    runner.cancel();
  }, [runner]);

  // Cmd+Enter is handled by QueryEditor's keymap extension; no global listener needed.

  return (
    <div className={styles.root}>
      {/* Toolbar */}
      <InsightsToolbar
        connectionId={connectionId}
        selectedGroups={selectedGroups}
        onGroupsChange={setSelectedGroups}
        timeRange={timeRange}
        onTimeRangeChange={setTimeRange}
        onRun={handleRun}
        running={runner.state.status === "running"}
        onCancel={handleCancel}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((prev) => !prev)}
        readiness={readiness}
      />

      {/* Editor area */}
      <div className={styles.editorArea} style={{ flex: 1, minHeight: 0 }}>
        <div className={styles.editorRow}>
          <div className={styles.editorWrap} style={{ height: "100%" }}>
            <QueryEditor
              ref={editorRef}
              initialQuery={initialQuery}
              onChange={() => {}}
              onRun={handleRun}
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

      {/* Resize handle */}
      <button
        type="button"
        className={styles.handle}
        aria-label="Resize result panel"
        onMouseDown={onHandleMouseDown}
      />

      {/* Result area */}
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
          <InsightsResultPanel state={runner.state} connectionName={connectionName} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Register tab kind.
// ---------------------------------------------------------------------------
TabRegistry.register(CLOUDWATCH_INSIGHTS_KIND, InsightsTabRoot);
