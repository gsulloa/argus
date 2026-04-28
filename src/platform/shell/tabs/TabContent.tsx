import { useEffect, useState } from "react";
import { TabRegistry } from "./TabRegistry";
import { useTabs } from "./TabsContext";
import styles from "./TabContent.module.css";

export function TabContent() {
  const { tabs, activeTabId } = useTabs();
  // Force re-render when registry changes so newly-registered kinds become visible.
  const [, setVersion] = useState(0);
  useEffect(() => TabRegistry.subscribe(() => setVersion((v) => v + 1)), []);

  const active = tabs.find((t) => t.id === activeTabId);

  if (!active) {
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

  const Renderer = TabRegistry.get(active.kind);
  return (
    <div className={styles.root}>
      {Renderer ? (
        <Renderer tab={active} />
      ) : (
        <div className={styles.unknown}>
          No renderer registered for tab kind <code>{active.kind}</code>.
        </div>
      )}
    </div>
  );
}
