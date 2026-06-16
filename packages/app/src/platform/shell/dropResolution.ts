import type { Connection } from "@/platform/connection-registry/types";

export const UNGROUPED_DROPPABLE_ID = "__ungrouped__";

export interface DropTarget {
  groupId: string | null;
  dropIndex: number;
}

export function resolveConnectionDropTarget(
  overId: string,
  draggingId: string,
  byGroup: Map<string, Connection[]>,
  ungrouped: Connection[],
): DropTarget | null {
  if (overId === draggingId) return null;

  // GroupHeader registers two droppables on the same DOM node: one via
  // useSortable (id `group-sortable:<g>`) for group reordering, and one via
  // useDroppable (id `group-header:<g>`) for connection drops. closestCenter
  // ties at the same center point and may return either id; both must
  // resolve to "append at end of this group" for connection drops.
  if (
    overId.startsWith("group-header:") ||
    overId.startsWith("group-sortable:")
  ) {
    const groupId = overId.slice(overId.indexOf(":") + 1);
    const targetItems = byGroup.get(groupId) ?? [];
    return { groupId, dropIndex: targetItems.length };
  }

  if (overId === UNGROUPED_DROPPABLE_ID) {
    return { groupId: null, dropIndex: ungrouped.length };
  }

  // overId is a raw connection id — find which group it belongs to
  for (const [groupId, members] of byGroup) {
    if (members.some((c) => c.id === overId)) {
      const filtered = members.filter((c) => c.id !== draggingId);
      let dropIndex = filtered.findIndex((c) => c.id === overId);
      if (dropIndex < 0) dropIndex = filtered.length;
      return { groupId, dropIndex };
    }
  }

  if (ungrouped.some((c) => c.id === overId)) {
    const filtered = ungrouped.filter((c) => c.id !== draggingId);
    let dropIndex = filtered.findIndex((c) => c.id === overId);
    if (dropIndex < 0) dropIndex = filtered.length;
    return { groupId: null, dropIndex };
  }

  return null;
}
