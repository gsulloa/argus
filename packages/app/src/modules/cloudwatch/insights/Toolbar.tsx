/**
 * CloudWatch Insights toolbar.
 *
 * Carries:
 *  - Log group multi-select (from the connection's groups, up to 50)
 *  - Time-range picker (relative presets + custom absolute)
 *
 * Relative presets are stored as-is; they are resolved to concrete epoch
 * seconds AT RUN TIME (not at selection time), so re-runs use a fresh window.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cloudwatchApi } from "../api";
import type { AiReadiness } from "@/modules/ai/useAiReadiness";
import type { LogGroupItem, RelativePreset, TimeRange } from "../types";
import styles from "@/modules/mysql/sql/QueryTab.module.css";

// ---------------------------------------------------------------------------
// Relative preset → epoch seconds helpers
// ---------------------------------------------------------------------------

const PRESET_LABELS: Record<RelativePreset, string> = {
  "5m": "Last 5 min",
  "15m": "Last 15 min",
  "1h": "Last 1 hour",
  "3h": "Last 3 hours",
  "12h": "Last 12 hours",
  "1d": "Last 1 day",
  "1w": "Last 7 days",
};

const PRESET_SECONDS: Record<RelativePreset, number> = {
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "3h": 3 * 60 * 60,
  "12h": 12 * 60 * 60,
  "1d": 24 * 60 * 60,
  "1w": 7 * 24 * 60 * 60,
};

const PRESETS: RelativePreset[] = ["5m", "15m", "1h", "3h", "12h", "1d", "1w"];

/** Resolve a TimeRange to concrete epoch seconds at call time. */
export function resolveTimeRange(range: TimeRange): { startTime: number; endTime: number } {
  if (range.kind === "absolute") {
    return { startTime: range.startEpochS, endTime: range.endEpochS };
  }
  const nowS = Math.floor(Date.now() / 1000);
  return {
    startTime: nowS - PRESET_SECONDS[range.preset],
    endTime: nowS,
  };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ToolbarProps {
  connectionId: string;
  selectedGroups: string[];
  onGroupsChange: (groups: string[]) => void;
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
  onRun: () => void;
  running: boolean;
  onCancel?: () => void;
  /** Whether the AI chat panel is currently open. */
  panelOpen: boolean;
  /** Callback to toggle the AI chat panel open/closed. */
  onTogglePanel: () => void;
  /** AI readiness state for the connection. */
  readiness: AiReadiness;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InsightsToolbar({
  connectionId,
  selectedGroups,
  onGroupsChange,
  timeRange,
  onTimeRangeChange,
  onRun,
  running,
  onCancel,
  panelOpen,
  onTogglePanel,
  readiness,
}: ToolbarProps) {
  const [availableGroups, setAvailableGroups] = useState<LogGroupItem[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [timeOpen, setTimeOpen] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const groupsDropRef = useRef<HTMLDivElement>(null);
  const timeDropRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Search log groups server-side as the user types. An empty term loads the
  // first page. Debounced; the effect cleanup cancels any in-flight request so
  // a newer query always supersedes an older one (no out-of-order overwrite).
  // Only runs while the dropdown is open to avoid needless calls.
  useEffect(() => {
    if (!groupsOpen) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      setGroupsLoading(true);
      setGroupsError(null);
      void (async () => {
        try {
          const resp = await cloudwatchApi.listLogGroups(
            connectionId,
            undefined,
            50,
            searchTerm.trim() || undefined,
          );
          if (!cancelled) setAvailableGroups(resp.groups);
        } catch (e) {
          if (!cancelled) {
            setAvailableGroups([]);
            setGroupsError((e as Error).message ?? "Failed to load log groups.");
          }
        } finally {
          if (!cancelled) setGroupsLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [connectionId, searchTerm, groupsOpen]);

  // Focus the search field when the dropdown opens.
  useEffect(() => {
    if (groupsOpen) searchInputRef.current?.focus();
  }, [groupsOpen]);

  // Close dropdowns on outside click
  useEffect(() => {
    if (!groupsOpen && !timeOpen) return;
    function handleClick(e: MouseEvent) {
      if (groupsOpen && groupsDropRef.current && !groupsDropRef.current.contains(e.target as Node)) {
        setGroupsOpen(false);
      }
      if (timeOpen && timeDropRef.current && !timeDropRef.current.contains(e.target as Node)) {
        setTimeOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [groupsOpen, timeOpen]);

  function toggleGroup(name: string) {
    if (selectedGroups.includes(name)) {
      onGroupsChange(selectedGroups.filter((g) => g !== name));
    } else if (selectedGroups.length < 50) {
      onGroupsChange([...selectedGroups, name]);
    }
  }

  const handleRelativePreset = useCallback(
    (preset: RelativePreset) => {
      onTimeRangeChange({ kind: "relative", preset });
      setTimeOpen(false);
    },
    [onTimeRangeChange],
  );

  function handleApplyCustomRange() {
    if (!customStart || !customEnd) return;
    const startEpochS = Math.floor(new Date(customStart).getTime() / 1000);
    const endEpochS = Math.floor(new Date(customEnd).getTime() / 1000);
    if (!isFinite(startEpochS) || !isFinite(endEpochS) || startEpochS >= endEpochS) return;
    onTimeRangeChange({ kind: "absolute", startEpochS, endEpochS });
    setTimeOpen(false);
  }

  const timeLabel =
    timeRange.kind === "relative"
      ? PRESET_LABELS[timeRange.preset]
      : "Custom range";

  const groupsLabel =
    selectedGroups.length === 0
      ? "Select log groups…"
      : selectedGroups.length === 1
        ? selectedGroups[0]!
        : `${selectedGroups.length} groups`;

  // Keep already-selected groups visible even when they fall outside the
  // current (searched) result set, so a selection survives across searches.
  const resultNames = new Set(availableGroups.map((g) => g.name));
  const pinnedSelected = selectedGroups.filter((n) => !resultNames.has(n));

  function groupRow(name: string, checked: boolean) {
    return (
      <label
        key={name}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px",
          cursor: "pointer",
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          color: "var(--text)",
          background: checked ? "var(--accent-soft)" : "transparent",
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggleGroup(name)}
          style={{ margin: 0 }}
        />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
        </span>
      </label>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
        flexShrink: 0,
        flexWrap: "wrap",
      }}
    >
      {/* Log group multi-select */}
      <div style={{ position: "relative" }} ref={groupsDropRef}>
        <button
          type="button"
          className={styles.toolbarButton}
          onClick={() => setGroupsOpen((v) => !v)}
          style={{
            maxWidth: 260,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: selectedGroups.length === 0 ? "var(--text-muted)" : "var(--text)",
          }}
          title={selectedGroups.length > 0 ? selectedGroups.join(", ") : "Select log groups"}
        >
          {groupsLabel}
          <span style={{ marginLeft: 4, fontSize: 10 }}>▾</span>
        </button>
        {groupsOpen && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              zIndex: 200,
              background: "var(--elevated)",
              border: "1px solid var(--border-strong)",
              borderRadius: 5,
              minWidth: 280,
              maxWidth: 400,
              maxHeight: 280,
              overflow: "auto",
              boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
            }}
          >
            {/* Search field — queries all account log groups server-side. */}
            <div
              style={{
                position: "sticky",
                top: 0,
                background: "var(--elevated)",
                borderBottom: "1px solid var(--border)",
                padding: 6,
                zIndex: 1,
              }}
            >
              <input
                ref={searchInputRef}
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search log groups…"
                spellCheck={false}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "5px 8px",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text)",
                  background: "var(--surface)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: 4,
                  outline: "none",
                }}
              />
            </div>

            {/* Selected groups outside the current results stay visible. */}
            {pinnedSelected.map((name) => groupRow(name, true))}
            {pinnedSelected.length > 0 && availableGroups.length > 0 && (
              <div style={{ borderTop: "1px solid var(--border)" }} aria-hidden="true" />
            )}

            {groupsLoading && (
              <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-muted)" }}>
                Loading groups…
              </div>
            )}
            {!groupsLoading && groupsError && (
              <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--danger, #f87171)" }}>
                {groupsError}
              </div>
            )}
            {!groupsLoading && !groupsError && availableGroups.length === 0 && (
              <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-muted)" }}>
                {searchTerm.trim()
                  ? `No log groups match "${searchTerm.trim()}".`
                  : "No log groups available."}
              </div>
            )}
            {availableGroups.map((g) => groupRow(g.name, selectedGroups.includes(g.name)))}

            {selectedGroups.length > 0 && (
              <div
                style={{
                  position: "sticky",
                  bottom: 0,
                  background: "var(--elevated)",
                  borderTop: "1px solid var(--border)",
                  padding: "4px 12px",
                }}
              >
                <button
                  type="button"
                  className={styles.toolbarButton}
                  onClick={() => { onGroupsChange([]); }}
                  style={{ fontSize: 11 }}
                >
                  Clear all
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Divider */}
      <span className={styles.toolbarDivider} aria-hidden="true" />

      {/* Time range picker */}
      <div style={{ position: "relative" }} ref={timeDropRef}>
        <button
          type="button"
          className={styles.toolbarButton}
          onClick={() => setTimeOpen((v) => !v)}
          title="Select time range"
        >
          {timeLabel}
          <span style={{ marginLeft: 4, fontSize: 10 }}>▾</span>
        </button>
        {timeOpen && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              zIndex: 200,
              background: "var(--elevated)",
              border: "1px solid var(--border-strong)",
              borderRadius: 5,
              minWidth: 220,
              boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
              overflow: "hidden",
            }}
          >
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => handleRelativePreset(preset)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 12px",
                  fontSize: 12,
                  background:
                    timeRange.kind === "relative" && timeRange.preset === preset
                      ? "var(--accent-soft)"
                      : "transparent",
                  color:
                    timeRange.kind === "relative" && timeRange.preset === preset
                      ? "var(--accent)"
                      : "var(--text)",
                  border: "none",
                  cursor: "pointer",
                  fontFamily: "var(--font-ui)",
                }}
              >
                {PRESET_LABELS[preset]}
              </button>
            ))}
            <div
              style={{
                borderTop: "1px solid var(--border)",
                padding: "8px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
                Custom absolute range
              </div>
              <input
                type="datetime-local"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                style={customInputStyle}
                placeholder="Start"
              />
              <input
                type="datetime-local"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                style={customInputStyle}
                placeholder="End"
              />
              <button
                type="button"
                className={styles.toolbarButton}
                onClick={handleApplyCustomRange}
                disabled={!customStart || !customEnd}
              >
                Apply
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Divider */}
      <span className={styles.toolbarDivider} aria-hidden="true" />

      {/* ✨ AI chat panel toggle */}
      <button
        type="button"
        className={`${styles.toolbarButton} ${styles.aiButton}`}
        onClick={onTogglePanel}
        title={
          readiness.level === "ready"
            ? "Open AI chat panel"
            : "Set up AI to start chatting"
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

      {/* Divider */}
      <span className={styles.toolbarDivider} aria-hidden="true" />

      {/* Run / Cancel */}
      {running ? (
        <button
          type="button"
          className={styles.toolbarButton}
          onClick={onCancel}
          style={{ color: "var(--danger)" }}
        >
          Cancel
        </button>
      ) : (
        <button
          type="button"
          className={styles.toolbarButton}
          onClick={onRun}
          disabled={selectedGroups.length === 0}
          title={selectedGroups.length === 0 ? "Select at least one log group" : "Run query (⌘↩)"}
        >
          Run
          <span className={styles.kbd}>⌘↩</span>
        </button>
      )}
    </div>
  );
}

const customInputStyle: React.CSSProperties = {
  background: "var(--canvas)",
  border: "1px solid var(--border-strong)",
  borderRadius: 3,
  color: "var(--text)",
  padding: "3px 6px",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  width: "100%",
};
