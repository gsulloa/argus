/**
 * CloudWatch Logs events viewer tab.
 *
 * Tab kind: "cloudwatch-events"
 * Payload: { connectionId, connectionName, groupName, streamName }
 *
 * Renders a read-only events viewer (timestamp + message) with
 * "Load older" (backward token) and "Load newer" (forward token) paging.
 * Registers itself with TabRegistry on import.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import type { Tab } from "@/platform/shell/tabs/types";
import { cloudwatchApi } from "../api";
import {
  formatLogTs,
  matchesLogSubstring,
  matchesLogFuzzy,
  prettyMaybeJson,
  highlightSegments,
} from "../logFormat";
import type { LogEventItem } from "../types";
import styles from "@/modules/mysql/sql/QueryTab.module.css";

export const CLOUDWATCH_EVENTS_KIND = "cloudwatch-events";

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export interface EventsTabPayload {
  connectionId: string;
  connectionName: string;
  groupName: string;
  streamName: string;
}

function isPayload(v: unknown): v is EventsTabPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.connectionId === "string" &&
    typeof o.connectionName === "string" &&
    typeof o.groupName === "string" &&
    typeof o.streamName === "string"
  );
}

// ---------------------------------------------------------------------------
// Tab shell
// ---------------------------------------------------------------------------

function EventsTabRoot({ tab, active }: { tab: Tab; active: boolean }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.invalid}>Invalid CloudWatch events tab payload.</div>;
  }
  return <EventsTabInner payload={tab.payload} active={active} />;
}

// ---------------------------------------------------------------------------
// Inner tab
// ---------------------------------------------------------------------------

type PageState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded" };

function EventsTabInner({ payload, active }: { payload: EventsTabPayload; active: boolean }) {
  const { connectionId, connectionName, groupName, streamName } = payload;

  const [events, setEvents] = useState<LogEventItem[]>([]);
  const [forwardToken, setForwardToken] = useState<string | null>(null);
  const [backwardToken, setBackwardToken] = useState<string | null>(null);
  const [pageState, setPageState] = useState<PageState>({ status: "idle" });
  const [loadOlderState, setLoadOlderState] = useState<"idle" | "loading">("idle");
  const [loadNewerState, setLoadNewerState] = useState<"idle" | "loading">("idle");

  // ⌘F local filter over the loaded events (client-side, case-insensitive fuzzy).
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const filterInputRef = useRef<HTMLInputElement>(null);

  const filteredEvents = useMemo(() => {
    const q = filterQuery.trim();
    if (!q) return events;
    // Substring is the real filter; fuzzy only rescues when nothing matched
    // (per-line subsequence is too permissive to be the default).
    const substr = events.filter((ev) => matchesLogSubstring(ev.message, q));
    if (substr.length > 0) return substr;
    return events.filter((ev) => matchesLogFuzzy(ev.message, q));
  }, [events, filterQuery]);

  // ⌘F / ⌃F opens the local filter bar (gated on the active tab, skipping text
  // surfaces). Esc closes + clears. Mirrors DataViewTab / TableViewerTab.
  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "f" && !e.shiftKey && !e.altKey) {
        const focused = document.activeElement as HTMLElement | null;
        const tag = focused?.tagName.toUpperCase();
        if (tag === "INPUT" || tag === "TEXTAREA" || focused?.closest(".cm-editor")) return;
        e.preventDefault();
        setFilterOpen(true);
        requestAnimationFrame(() => filterInputRef.current?.focus());
      } else if (e.key === "Escape" && filterOpen) {
        setFilterOpen(false);
        setFilterQuery("");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, filterOpen]);

  // Initial load: most recent events (startFromHead: false)
  const loadInitial = useCallback(async () => {
    setPageState({ status: "loading" });
    setEvents([]);
    setForwardToken(null);
    setBackwardToken(null);
    try {
      const resp = await cloudwatchApi.getLogEvents(connectionId, groupName, streamName, {
        startFromHead: false,
      });
      setEvents(resp.events);
      setForwardToken(resp.next_forward_token ?? null);
      setBackwardToken(resp.next_backward_token ?? null);
      setPageState({ status: "loaded" });
    } catch (e) {
      setPageState({ status: "error", message: (e as Error).message ?? "Failed to load events." });
    }
  }, [connectionId, groupName, streamName]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  // Load older events (backward token — prepend)
  const handleLoadOlder = useCallback(async () => {
    if (!backwardToken || loadOlderState === "loading") return;
    setLoadOlderState("loading");
    try {
      const resp = await cloudwatchApi.getLogEvents(connectionId, groupName, streamName, {
        backwardToken,
      });
      setEvents((prev) => [...resp.events, ...prev]);
      setBackwardToken(resp.next_backward_token ?? null);
      // Forward token stays — we prepended older events
    } catch (e) {
      console.error("[cloudwatch] loadOlder:", e);
    } finally {
      setLoadOlderState("idle");
    }
  }, [connectionId, groupName, streamName, backwardToken, loadOlderState]);

  // Load newer events (forward token — append)
  const handleLoadNewer = useCallback(async () => {
    if (!forwardToken || loadNewerState === "loading") return;
    setLoadNewerState("loading");
    try {
      const resp = await cloudwatchApi.getLogEvents(connectionId, groupName, streamName, {
        forwardToken,
      });
      setEvents((prev) => [...prev, ...resp.events]);
      setForwardToken(resp.next_forward_token ?? null);
    } catch (e) {
      console.error("[cloudwatch] loadNewer:", e);
    } finally {
      setLoadNewerState("idle");
    }
  }, [connectionId, groupName, streamName, forwardToken, loadNewerState]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className={styles.root} style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div className={styles.editorToolbar}>
        <span className={styles.connectionPill} title={connectionId}>
          {connectionName}
        </span>
        <span className={styles.toolbarDivider} aria-hidden="true" />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-muted)",
            maxWidth: 400,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={`${groupName} / ${streamName}`}
        >
          {groupName} / {streamName}
        </span>
        <span className={styles.toolbarDivider} aria-hidden="true" />
        <button
          type="button"
          className={styles.toolbarButton}
          onClick={() => void loadInitial()}
          disabled={pageState.status === "loading"}
        >
          Refresh
        </button>
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {pageState.status === "loading" && (
          <div style={emptyStyle}>Loading events…</div>
        )}
        {pageState.status === "error" && (
          <div
            style={{
              margin: 8,
              padding: "8px 12px",
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 4,
              fontSize: 12,
              color: "var(--danger)",
            }}
            role="alert"
          >
            {pageState.message}
          </div>
        )}
        {pageState.status === "loaded" && (
          <>
            {/* ⌘F local filter bar */}
            {filterOpen && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  borderBottom: "1px solid var(--border)",
                  flexShrink: 0,
                }}
              >
                <input
                  ref={filterInputRef}
                  type="text"
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setFilterOpen(false);
                      setFilterQuery("");
                    }
                  }}
                  placeholder="Filter loaded events…"
                  spellCheck={false}
                  aria-label="Filter loaded events"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: "6px 10px",
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text)",
                    background: "var(--surface)",
                    border: "1px solid var(--border-strong)",
                    borderRadius: "var(--radius-md, 5px)",
                    outline: "none",
                  }}
                />
                <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  {filteredEvents.length} of {events.length}
                </span>
                <button
                  type="button"
                  className={styles.toolbarButton}
                  onClick={() => {
                    setFilterOpen(false);
                    setFilterQuery("");
                  }}
                  aria-label="Close filter"
                >
                  Close
                </button>
              </div>
            )}

            {/* Load older button */}
            {backwardToken && (
              <div style={{ padding: "4px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                <button
                  type="button"
                  className={styles.toolbarButton}
                  onClick={() => void handleLoadOlder()}
                  disabled={loadOlderState === "loading"}
                >
                  {loadOlderState === "loading" ? "Loading…" : "Load older"}
                </button>
              </div>
            )}

            {/* Events table */}
            <div style={{ flex: 1, overflow: "auto" }}>
              {events.length === 0 ? (
                <div style={emptyStyle}>(no events)</div>
              ) : filteredEvents.length === 0 ? (
                <div style={emptyStyle}>No events match &ldquo;{filterQuery.trim()}&rdquo;.</div>
              ) : (
                <table
                  style={{
                    borderCollapse: "collapse",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    width: "100%",
                  }}
                >
                  <thead>
                    <tr>
                      <th style={thStyle}>Timestamp</th>
                      <th style={{ ...thStyle, width: "100%" }}>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEvents.map((ev, i) => (
                      <tr key={i}>
                        <td
                          style={{
                            ...tdStyle,
                            whiteSpace: "nowrap",
                            width: 196,
                            minWidth: 196,
                            color: "var(--text-muted)",
                            userSelect: "text",
                            verticalAlign: "top",
                          }}
                        >
                          {formatLogTs(ev.ts) || "—"}
                        </td>
                        <td
                          style={{
                            ...tdStyle,
                            userSelect: "text",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            overflowWrap: "anywhere",
                            verticalAlign: "top",
                          }}
                        >
                          {renderHighlightedMessage(prettyMaybeJson(ev.message).text, filterQuery)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Load newer button */}
            {forwardToken && (
              <div style={{ padding: "4px 8px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
                <button
                  type="button"
                  className={styles.toolbarButton}
                  onClick={() => void handleLoadNewer()}
                  disabled={loadNewerState === "loading"}
                >
                  {loadNewerState === "loading" ? "Loading…" : "Load newer"}
                </button>
              </div>
            )}

            {/* No forward token = at the end */}
            {!forwardToken && events.length > 0 && (
              <div
                style={{
                  padding: "4px 8px",
                  borderTop: "1px solid var(--border)",
                  fontSize: 11,
                  color: "var(--text-subtle)",
                  fontStyle: "italic",
                  flexShrink: 0,
                }}
              >
                End of stream — {events.length} event{events.length !== 1 ? "s" : ""} shown
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Highlighted message — marks filter matches in the brand accent.
// ---------------------------------------------------------------------------

function renderHighlightedMessage(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  return highlightSegments(text, query).map((seg, i) =>
    seg.match ? (
      <mark key={i} style={markStyle}>
        {seg.text}
      </mark>
    ) : (
      <span key={i}>{seg.text}</span>
    ),
  );
}

const markStyle: React.CSSProperties = {
  background: "var(--accent-soft)",
  color: "var(--accent-hover, var(--text))",
  borderRadius: "var(--radius-sm, 3px)",
  padding: "0 1px",
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const emptyStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  fontSize: 12,
  color: "var(--text-subtle)",
  fontStyle: "italic",
};

const thStyle: React.CSSProperties = {
  padding: "3px 8px",
  textAlign: "left",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-muted)",
  fontWeight: 500,
  whiteSpace: "nowrap",
  position: "sticky",
  top: 0,
  userSelect: "none",
};

const tdStyle: React.CSSProperties = {
  padding: "2px 8px",
  borderBottom: "1px solid var(--hairline, rgba(255,255,255,0.04))",
  color: "var(--text)",
  verticalAlign: "top",
};

// ---------------------------------------------------------------------------
// Register tab kind.
// ---------------------------------------------------------------------------
TabRegistry.register(CLOUDWATCH_EVENTS_KIND, EventsTabRoot);
