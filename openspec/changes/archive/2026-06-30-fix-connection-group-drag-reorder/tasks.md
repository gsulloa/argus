## 1. Implement type-scoped collision detection

- [x] 1.1 In `packages/app/src/platform/shell/Sidebar.tsx`, add a custom collision-detection function (e.g. `connectionsCollisionDetection`) that reads `args.active.id`, determines `isGroupDrag = id.startsWith("group-sortable:")`, filters `args.droppableContainers` to only `group-sortable:` ids when dragging a group and to non-`group-sortable:` ids otherwise, then returns `closestCenter({ ...args, droppableContainers: filtered })`.
- [x] 1.2 Add a short comment documenting the two-type (group vs. connection) assumption so future sortable types extend the predicate.
- [x] 1.3 Replace `collisionDetection={closestCenter}` on the `DndContext` (around line 352) with the new function. Confirm `closestCenter` remains imported from `@dnd-kit/core`.

## 2. Verify behavior

- [x] 2.1 Build/typecheck the app and confirm no TypeScript errors from the collision function signature (it must satisfy dnd-kit's `CollisionDetection` type). — `pnpm -C packages/app typecheck` passed clean.
- [x] 2.2 Manual QA: with ≥2 groups (some expanded with connections, plus an ungrouped section), drag a group's handle past intervening connection rows to a new position and confirm it reorders and persists across reload (one `connection_groups.update` call).
- [x] 2.3 Manual QA: confirm connection drag/reorder, move-between-groups, drop-onto-empty-group-header, and move-into-ungrouped all still work unchanged.
- [x] 2.4 Manual QA: keyboard-activate a group drag, move with arrow keys, commit, and confirm the reorder plus screen-reader announcement.
- [x] 2.5 Manual QA: release a group drag over a connection row / ungrouped header and confirm no IPC call and no reorder (existing guard behavior preserved).

## 3. Spec alignment

- [x] 3.1 Confirm the implementation matches the modified `connection-groups` requirement (scoped collision + "Reorder a group across intervening connection rows" scenario). — `connectionsCollisionDetection` scopes group drags to `group-sortable:` containers only; the existing `handleGroupDragEnd` guard preserves "ignores non-group drop targets".
