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

import { useCallback, useRef, useState } from "react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import type { Tab } from "@/platform/shell/tabs/types";
import { InsightsToolbar } from "./Toolbar";
import { QueryEditor, type QueryEditorHandle } from "./QueryEditor";
import { InsightsResultPanel } from "./ResultPanel";
import { useInsightsQueryRun } from "./useQueryRun";
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

  // Resizable result panel
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
      />

      {/* Editor area */}
      <div className={styles.editorArea} style={{ flex: 1, minHeight: 0 }}>
        <div className={styles.editorRow} style={{ height: "100%" }}>
          <div className={styles.editorWrap} style={{ height: "100%" }}>
            <QueryEditor
              ref={editorRef}
              initialQuery={initialQuery}
              onChange={() => {}}
              onRun={handleRun}
            />
          </div>
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
