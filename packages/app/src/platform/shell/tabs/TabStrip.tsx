import type { CSSProperties } from "react";
import { useCallback, useMemo } from "react";
import { X } from "lucide-react";
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
import type { Tab } from "./types";
import styles from "./TabStrip.module.css";

interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
}

// The whole tab is the drag handle — a 32px-tall tab has no room for a grip
// without it reading as clutter (design D2), so `attributes`/`listeners`
// spread onto the tab `<div>` itself and the pointer activation distance
// (below) is what separates a click from a drag.
function TabItem({ tab, isActive, onActivate, onClose }: TabItemProps) {
  const sortable = useSortable({ id: tab.id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    ...(sortable.isDragging ? { zIndex: 1 } : null),
  };

  return (
    <div
      ref={sortable.setNodeRef}
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
      <span>{tab.title}</span>
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

  if (tabs.length === 0) return null;

  return (
    <div className={styles.root} role="tablist">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <TabItem
                key={tab.id}
                tab={tab}
                isActive={isActive}
                onActivate={() => {
                  if (tab.id === activeTabId) return; // already active — no switch
                  // Consult the leaving tab's activate handler before switching.
                  void shouldActivateTab(activeTabId ?? "").then((ok) => {
                    if (ok) activate(tab.id);
                  });
                }}
                onClose={() => {
                  // Consult any registered close-handler (e.g. dirty buffer in
                  // the table viewer). When it resolves to false the tab stays
                  // open; the handler is responsible for surfacing UI.
                  void shouldCloseTab(tab.id).then((ok) => {
                    if (ok) close(tab.id);
                  });
                }}
              />
            );
          })}
        </SortableContext>
      </DndContext>
    </div>
  );
}
