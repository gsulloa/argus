import { ChevronDown, X } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useState } from "react";
import { useTabs } from "./TabsContext";
import { shouldCloseTab, shouldActivateTab } from "./useCloseConfirm";
import { useTabOverflow } from "./useTabOverflow";
import styles from "./TabStrip.module.css";

export function TabStrip() {
  const { tabs, activeTabId, activate, close, move } = useTabs();
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    index: number;
    side: "before" | "after";
  } | null>(null);
  const { scrollerRef, registerTab, scrollTabIntoView, hiddenIds } =
    useTabOverflow(tabs);

  // Consult the leaving tab's activate handler before switching. Shared by the
  // tab click and the overflow menu so both honour the same guard.
  function requestActivate(id: string) {
    if (id === activeTabId) return; // already active — no switch
    void shouldActivateTab(activeTabId ?? "").then((ok) => {
      if (ok) activate(id);
    });
  }

  // Keep the active tab visible. Keyed on `activeTabId` only: manual scrolling
  // is never overridden, and every activation path (strip click, ⌃Tab, the
  // command palette, the quick-switcher, the overflow menu, and `open` — which
  // sets `activeTabId`) lands here.
  useEffect(() => {
    if (activeTabId) scrollTabIntoView(activeTabId);
  }, [activeTabId, scrollTabIntoView]);

  if (tabs.length === 0) return null;

  const hidden = new Set(hiddenIds);
  // Resolve from `tabs` so the menu lists hidden tabs in tab order.
  const hiddenTabs = tabs.filter((t) => hidden.has(t.id));

  return (
    <div className={styles.root}>
      <div className={styles.scroller} role="tablist" ref={scrollerRef}>
        {tabs.map((tab, idx) => {
          const isActive = tab.id === activeTabId;
          const isDropBefore = dropTarget?.index === idx && dropTarget.side === "before";
          const isDropAfter = dropTarget?.index === idx && dropTarget.side === "after";
          return (
            <div
              key={tab.id}
              ref={registerTab(tab.id)}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              className={styles.tab}
              data-active={isActive}
              data-dragging={dragIdx === idx}
              data-drop-before={isDropBefore}
              data-drop-after={isDropAfter}
              draggable
              onClick={() => {
                requestActivate(tab.id);
              }}
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
              <span className={styles.title} title={tab.title}>
                {tab.title}
              </span>
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
      {hiddenTabs.length > 0 && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className={styles.overflowButton}
              aria-label={`Show ${hiddenTabs.length} hidden ${
                hiddenTabs.length === 1 ? "tab" : "tabs"
              }`}
              title="Hidden tabs"
            >
              <ChevronDown size={13} />
              {hiddenTabs.length}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className={styles.contextMenu} align="end">
              {hiddenTabs.map((tab) => (
                <DropdownMenu.Item
                  key={tab.id}
                  className={styles.contextItem}
                  onSelect={() => requestActivate(tab.id)}
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
                  <span className={styles.title} title={tab.title}>
                    {tab.title}
                  </span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );
}
