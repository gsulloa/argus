import { ChevronDown, ChevronRight, GripVertical, MoreHorizontal } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useDroppable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ConnectionGroup } from "@/platform/connection-registry/types";
import styles from "./Sidebar.module.css";

export function GroupHeader({
  group,
  memberCount,
  expanded,
  onToggle,
  onRename,
  onSortAlphabetically,
  onDelete,
}: {
  group: ConnectionGroup;
  memberCount: number;
  expanded: boolean;
  onToggle: () => void;
  onRename: () => void;
  onSortAlphabetically: () => void;
  onDelete: () => void;
}) {
  const sortable = useSortable({ id: `group-sortable:${group.id}` });
  const droppable = useDroppable({ id: `group-header:${group.id}` });

  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.5 : 1,
  };

  function setNodes(node: HTMLElement | null) {
    sortable.setNodeRef(node);
    droppable.setNodeRef(node);
  }

  return (
    <div
      ref={setNodes}
      style={style}
      className={styles.groupHeader}
      data-over={droppable.isOver || undefined}
    >
      <button
        type="button"
        className={styles.dragHandle}
        aria-label={`Drag group ${group.name}`}
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <GripVertical size={12} />
      </button>
      <button
        type="button"
        className={styles.groupChevron}
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? `Collapse ${group.name}` : `Expand ${group.name}`}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      <button
        type="button"
        className={styles.groupName}
        onClick={onToggle}
        title={group.name}
      >
        {group.name}
      </button>
      {!expanded && <span className={styles.groupCount}>{memberCount}</span>}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className={styles.groupMenuButton}
            aria-label={`${group.name} menu`}
            title="Group actions"
          >
            <MoreHorizontal size={14} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className={styles.contextMenu} align="end">
            <DropdownMenu.Item className={styles.contextItem} onSelect={onRename}>
              Rename
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={styles.contextItem}
              onSelect={onSortAlphabetically}
            >
              Sort alphabetically
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={`${styles.contextItem} ${styles.contextItemDanger}`}
              onSelect={onDelete}
            >
              Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
