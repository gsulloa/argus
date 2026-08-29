import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo } from "react";
import { ChevronDown, X } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTabs } from "./TabsContext";
import { shouldCloseTab, shouldActivateTab } from "./useCloseConfirm";
import { useTabOverflow } from "./useTabOverflow";
import type { Tab } from "./types";
import styles from "./TabStrip.module.css";

interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
  /** Overflow measurement ref for this tab's element. */
  registerRef: (el: HTMLElement | null) => void;
}

// The whole tab is the drag handle — a 32px-tall tab has no room for a grip
// without it reading as clutter (design D2), so `attributes`/`listeners`
// spread onto the tab `<div>` itself and the pointer activation distance
// (below) is what separates a click from a drag.
function TabItem({ tab, isActive, onActivate, onClose, registerRef }: TabItemProps) {
  const sortable = useSortable({ id: tab.id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    ...(sortable.isDragging ? { zIndex: 1 } : null),
  };

  // The element is needed by both dnd-kit (to size and translate the tab) and
  // by the overflow hook (to measure whether it fits), so the two ref sinks
  // are composed into one callback.
  const setNodeRef = sortable.setNodeRef;
  const setRefs = useCallback(
    (el: HTMLElement | null) => {
      setNodeRef(el);
      registerRef(el);
    },
    [setNodeRef, registerRef],
  );

  return (
    <div
      ref={setRefs}
      style={style}
      className={styles.tab}
      data-active={isActive}
      data-dragging={sortable.isDragging}
      {...sortable.attributes}
      {...sortable.listeners}
      // sortable.attributes carries its own role="button" and tabIndex; these
      // three must be written AFTER the spread above so they win and restore
      // the tab's real ARIA semantics. aria-roledescription="sortable" from
      // the spread is accurate and is left in place.
      role="tab"
      tabIndex={0}
      aria-selected={isActive}
      onClick={onActivate}
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
          // With the drag listeners now on the parent, a press on ✕ would
          // also arm the pointer sensor; stopping pointerdown here keeps the
          // close button inert with respect to dragging (design D7).
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <X size={11} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}

export function TabStrip() {
  const { tabs, activeTabId, activate, close, move } = useTabs();
  const { scrollerRef, registerTab, scrollTabIntoView, hiddenIds } =
    useTabOverflow(tabs);

  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs]);

  // 4px matches Sidebar.tsx, the other surface where the draggable element is
  // also the primary click target. Below the threshold the pointer sequence
  // completes as a normal click, so onActivate below is untouched.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const from = tabIds.indexOf(String(active.id));
      const to = tabIds.indexOf(String(over.id));
      if (from === -1 || to === -1) return;
      // `move` already handles the splice and its own bounds guards — no
      // index arithmetic is re-implemented here.
      move(from, to);
    },
    [tabIds, move],
  );

  // Consult the leaving tab's activate handler before switching. Shared by the
  // tab click and the overflow menu so both honour the same guard.
  const requestActivate = useCallback(
    (id: string) => {
      if (id === activeTabId) return; // already active — no switch
      void shouldActivateTab(activeTabId ?? "").then((ok) => {
        if (ok) activate(id);
      });
    },
    [activeTabId, activate],
  );

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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
            {tabs.map((tab) => (
              <TabItem
                key={tab.id}
                tab={tab}
                isActive={tab.id === activeTabId}
                registerRef={registerTab(tab.id)}
                onActivate={() => requestActivate(tab.id)}
                onClose={() => {
                  // Consult any registered close-handler (e.g. dirty buffer in
                  // the table viewer). When it resolves to false the tab stays
                  // open; the handler is responsible for surfacing UI.
                  void shouldCloseTab(tab.id).then((ok) => {
                    if (ok) close(tab.id);
                  });
                }}
              />
            ))}
          </SortableContext>
        </DndContext>
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
