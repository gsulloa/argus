import { useContext, useEffect, useState } from "react";
import { TabRegistry } from "./TabRegistry";
import { useTabs } from "./TabsContext";
import { FocusedConnectionCtxRef } from "@/platform/shell/FocusedConnectionContext";
import styles from "./TabContent.module.css";

export function TabContent() {
  const { activeTabId, _allSets } = useTabs();
  const focusedCtx = useContext(FocusedConnectionCtxRef);
  const focusedConnectionId = focusedCtx?.focusedConnectionId ?? null;

  // Force re-render when registry changes so newly-registered kinds become visible.
  const [, setVersion] = useState(0);
  useEffect(() => TabRegistry.subscribe(() => setVersion((v) => v + 1)), []);

  // Track which tab IDs have ever been activated across ALL connection sets
  // (lazy first-mount; freed on close). This preserves the "inactive tab
  // content remains mounted" guarantee and extends it per-connection (task 5.4).
  const [everActivated, setEverActivated] = useState<Set<string>>(
    () => new Set(),
  );

  // Add activeTabId of each connection set to ever-activated on activation.
  useEffect(() => {
    const toAdd: string[] = [];
    for (const [, set] of _allSets) {
      if (set.activeTabId) toAdd.push(set.activeTabId);
    }
    if (toAdd.length === 0) return;
    setEverActivated((prev) => {
      const missing = toAdd.filter((id) => !prev.has(id));
      if (missing.length === 0) return prev;
      const next = new Set(prev);
      for (const id of missing) next.add(id);
      return next;
    });
  }, [_allSets]);

  // Prune closed tabs from ever-activated set (across all connection sets).
  useEffect(() => {
    const openIds = new Set<string>();
    for (const [, set] of _allSets) {
      for (const t of set.tabs) openIds.add(t.id);
    }
    setEverActivated((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of prev) {
        if (!openIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [_allSets]);

  // Determine if any connection has tabs at all.
  const focusedSet = focusedConnectionId
    ? (_allSets.get(focusedConnectionId) ?? { tabs: [], activeTabId: null })
    : { tabs: [], activeTabId: null };

  const focusedHasTabs = focusedSet.tabs.length > 0;

  // When focused connection has no open tabs, show empty placeholder.
  if (!focusedHasTabs) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>
          <div>No tabs open.</div>
          <div className={styles.emptyHint}>
            Press <span className={styles.kbd}>⌘K</span> to open the command palette.
          </div>
        </div>
      </div>
    );
  }

  // Collect all ever-activated tabs across all connection sets (for mounting).
  const allTabs = new Map<string, { tab: import("./types").Tab; connectionId: string }>();
  for (const [connId, set] of _allSets) {
    for (const tab of set.tabs) {
      if (everActivated.has(tab.id)) {
        allTabs.set(tab.id, { tab, connectionId: connId });
      }
    }
  }

  return (
    <div className={styles.root}>
      {[...allTabs.values()].map(({ tab, connectionId }) => {
        // A tab is active (visible) iff:
        // 1. It belongs to the currently-focused connection, AND
        // 2. It is that connection's active tab.
        const isActive =
          connectionId === focusedConnectionId && tab.id === activeTabId;
        const Renderer = TabRegistry.get(tab.kind);
        return (
          <div
            key={tab.id}
            className={isActive ? styles.slot : styles.hidden}
            aria-hidden={isActive ? undefined : true}
          >
            {Renderer ? (
              <Renderer tab={tab} active={isActive} />
            ) : (
              <div className={styles.unknown}>
                No renderer registered for tab kind <code>{tab.kind}</code>.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
