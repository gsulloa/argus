import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./ActivityLogPanel.module.css";
import { ActivityLogRow } from "./ActivityLogRow";
import { useActivityLog, useFilteredActivityLog } from "./store";
import { useSetting } from "@/platform/settings/useSetting";
import { useConnections } from "@/platform/connection-registry/useConnections";

const STICK_THRESHOLD_PX = 32;

export function ActivityLogPanel() {
  const [showAuto, setShowAuto] = useSetting<boolean>("activityLog.showAuto", false);
  const filtered = useFilteredActivityLog(showAuto);
  const { clear } = useActivityLog();
  const { items: connections } = useConnections();

  const connectionLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of connections) map.set(c.id, c.name);
    return (id: string | null) => (id && map.get(id)) || "—";
  }, [connections]);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef<boolean>(true);
  const [pendingNew, setPendingNew] = useState(0);

  const onRowClick = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const onRowKeyDown = useCallback(
    (id: string) => (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setExpandedId((prev) => (prev === id ? null : id));
      } else if (e.key === "Escape") {
        setExpandedId(null);
      }
    },
    [],
  );

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const sticking = distance <= STICK_THRESHOLD_PX;
    stickRef.current = sticking;
    if (sticking) setPendingNew(0);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
      setPendingNew(0);
    } else {
      setPendingNew((n) => n + 1);
    }
    // when filtered length grows we want to reflect sticky state
  }, [filtered.length]);

  const jumpToTail = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setPendingNew(0);
  }, []);

  return (
    <div className={styles.root} aria-label="Activity log">
      <header className={styles.header}>
        <div className={styles.title}>Activity</div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.headerToggle}
            data-active={showAuto}
            aria-pressed={showAuto}
            onClick={() => setShowAuto((prev) => !prev)}
            title="Show internal (auto) activity"
          >
            Show internal
          </button>
          <button
            type="button"
            className={styles.headerButton}
            onClick={clear}
            title="Clear activity log"
          >
            Clear
          </button>
        </div>
      </header>
      <div ref={scrollerRef} className={styles.scroller} onScroll={onScroll}>
        {filtered.length === 0 ? (
          <div className={styles.empty}>No activity yet.</div>
        ) : (
          filtered.map((entry) => (
            <ActivityLogRow
              key={entry.id}
              entry={entry}
              expanded={expandedId === entry.id}
              connectionLabel={connectionLabel(entry.connection_id)}
              onClick={() => onRowClick(entry.id)}
              onKeyDown={onRowKeyDown(entry.id)}
            />
          ))
        )}
        {pendingNew > 0 ? (
          <button
            type="button"
            className={styles.newIndicator}
            onClick={jumpToTail}
            title="Jump to latest"
          >
            {pendingNew} new ↓
          </button>
        ) : null}
      </div>
    </div>
  );
}
