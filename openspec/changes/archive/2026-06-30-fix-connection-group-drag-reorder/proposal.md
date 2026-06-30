## Why

In the Connection Manager / connections sidebar, users cannot drag connection **groups** to reorder them (issue #208). The drag starts, but the group snaps back and nothing moves. A single `DndContext` uses `closestCenter` over a flat list that interleaves two sortable types — group headers (`group-sortable:<id>`) and connection rows (connection UUIDs) — plus per-group header droppables (`group-header:<id>`). When a group is dragged, `closestCenter` frequently resolves `over` to a neighboring connection row or to the group's own header droppable rather than to a sibling group. The `handleGroupDragEnd` guard then discards any non-`group-sortable:` target, so the reorder is silently dropped. The user perceives this as "the row above gets focused before I can drag the group."

## What Changes

- Add a **type-scoped collision-detection** strategy to the connections `DndContext`: when the active drag is a group (`group-sortable:<id>`), collisions resolve **only** against other group sortables; when the active drag is a connection, group-sortable headers are excluded from collision candidates (connection-row and `group-header:<id>` targets are kept).
- This makes group reordering succeed reliably regardless of expanded groups, connection rows, or the ungrouped section between the dragged group and its destination, while preserving the existing rule that a group drag released over a genuine non-group target (a connection row / ungrouped header in isolation) makes no IPC call.
- No change to IPC commands, persistence, the 4px pointer activation constraint, or keyboard drag-and-drop semantics.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `connection-groups`: refine the **"Drag and drop reorders and re-parents connections"** requirement so a group drag resolves its drop target only among group rows — guaranteeing a group can be reordered even when connection rows / the ungrouped header lie between source and destination — while keeping the existing "ignores non-group drop targets" behavior for genuinely off-target releases.

## Impact

- **Code**: `packages/app/src/platform/shell/Sidebar.tsx` — replace `collisionDetection={closestCenter}` with a custom type-aware collision function. No backend, schema, or IPC changes.
- **Behavior**: groups become reliably reorderable via pointer and keyboard; connection drag/re-parent behavior is unchanged.
- **Risk**: low — purely a frontend collision-detection refinement, isolated to the connections sidebar drag context.
