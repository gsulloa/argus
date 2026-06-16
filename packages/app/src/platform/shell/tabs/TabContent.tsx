import { useEffect, useState } from "react";
import { TabRegistry } from "./TabRegistry";
import { useTabs } from "./TabsContext";
import styles from "./TabContent.module.css";

export function TabContent() {
  const { tabs, activeTabId } = useTabs();
  // Force re-render when registry changes so newly-registered kinds become visible.
  const [, setVersion] = useState(0);
  useEffect(() => TabRegistry.subscribe(() => setVersion((v) => v + 1)), []);

  // Track which tab IDs have ever been activated (lazy first-mount; freed on close).
  const [everActivated, setEverActivated] = useState<Set<string>>(() => new Set());

  // Add activeTabId to the ever-activated set on each activation.
  useEffect(() => {
    if (!activeTabId) return;
    setEverActivated((prev) => {
      if (prev.has(activeTabId)) return prev;
      const next = new Set(prev);
      next.add(activeTabId);
      return next;
    });
  }, [activeTabId]);

  // Prune closed tabs from the ever-activated set.
  useEffect(() => {
    const openIds = new Set(tabs.map((t) => t.id));
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
  }, [tabs]);

  if (tabs.length === 0) {
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

  // Render one slot per ever-activated tab that is still open.
  const slots = tabs.filter((t) => everActivated.has(t.id));

  return (
    <div className={styles.root}>
      {slots.map((tab) => {
        const isActive = tab.id === activeTabId;
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
