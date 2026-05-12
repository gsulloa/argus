import { X } from "lucide-react";
import { useState } from "react";
import { useTabs } from "./TabsContext";
import { shouldCloseTab } from "./useCloseConfirm";
import styles from "./TabStrip.module.css";

export function TabStrip() {
  const { tabs, activeTabId, activate, close, move } = useTabs();
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    index: number;
    side: "before" | "after";
  } | null>(null);

  if (tabs.length === 0) return null;

  return (
    <div className={styles.root} role="tablist">
      {tabs.map((tab, idx) => {
        const isActive = tab.id === activeTabId;
        const isDropBefore = dropTarget?.index === idx && dropTarget.side === "before";
        const isDropAfter = dropTarget?.index === idx && dropTarget.side === "after";
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            className={styles.tab}
            data-active={isActive}
            data-dragging={dragIdx === idx}
            data-drop-before={isDropBefore}
            data-drop-after={isDropAfter}
            draggable
            onClick={() => activate(tab.id)}
            onDragStart={(e) => {
              setDragIdx(idx);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              const isLeftHalf = e.clientX - rect.left < rect.width / 2;
              setDropTarget({ index: idx, side: isLeftHalf ? "before" : "after" });
              e.dataTransfer.dropEffect = "move";
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx !== null && dropTarget !== null) {
                let target = dropTarget.index;
                if (dropTarget.side === "after") target += 1;
                if (target > dragIdx) target -= 1;
                move(dragIdx, target);
              }
              setDragIdx(null);
              setDropTarget(null);
            }}
            onDragEnd={() => {
              setDragIdx(null);
              setDropTarget(null);
            }}
          >
            {tab.dirty ? (
              <span
                className={styles.dirtyDot}
                title="Unsaved changes"
                aria-label="Unsaved changes"
              >
                ●
              </span>
            ) : null}
            <span>{tab.title}</span>
            {tab.closable && (
              <button
                className={styles.close}
                aria-label={`Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  // Consult any registered close-handler (e.g. dirty buffer in
                  // the table viewer). When it resolves to false the tab stays
                  // open; the handler is responsible for surfacing UI.
                  void shouldCloseTab(tab.id).then((ok) => {
                    if (ok) close(tab.id);
                  });
                }}
              >
                <X size={11} strokeWidth={2.5} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
