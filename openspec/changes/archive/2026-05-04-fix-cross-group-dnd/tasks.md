## 1. Extract drop-resolution helper

- [x] 1.1 Create `src/platform/shell/dropResolution.ts` exporting `resolveConnectionDropTarget(overId, draggingId, byGroup, ungrouped)` returning `{ groupId: string | null, dropIndex: number } | null`
- [x] 1.2 Move the existing `over.id` branching out of `Sidebar.tsx` `handleConnectionDragEnd` into the helper, preserving exact semantics for `group-header:<id>`, `__ungrouped__`, and raw connection ids
- [x] 1.3 Helper returns `null` for `overId === draggingId` and for `over` not found in any list

## 2. Unify the DndContext

- [x] 2.1 In `Sidebar.tsx`, replace the three nested `DndContext` providers with a single `DndContext` wrapping the entire connections section (groups list + ungrouped sentinel)
- [x] 2.2 Wire the single `onDragEnd` to dispatch by active id prefix: `group-sortable:` → group reorder; otherwise → connection move
- [x] 2.3 Inside the unified context, keep one `SortableContext` for group ordering (`group-sortable:*` ids, `verticalListSortingStrategy`) and one `SortableContext` per group plus one for ungrouped, each containing its rows
- [x] 2.4 Verify the `sensors` (PointerSensor + KeyboardSensor) are passed once at the top level

## 3. Tighten dispatch guards

- [x] 3.1 In `handleGroupDragEnd`, early-return if `String(over.id)` does not start with `group-sortable:` (avoids misroute when a group is dropped on a row)
- [x] 3.2 In `handleConnectionDragEnd`, early-return if `String(active.id)` starts with `group-sortable:` (defense-in-depth; dispatcher should already prevent this)

## 4. Make the ungrouped header a real droppable

- [x] 4.1 In `Sidebar.tsx`, refactor `UngroupedHeader` to call `useDroppable({ id: UNGROUPED_DROPPABLE_ID })` and apply its `setNodeRef` to the header element
- [x] 4.2 Add a `data-over` attribute on the header for the same hover-highlight treatment `GroupHeader` already uses

## 5. Tests — unit

- [x] 5.1 Create `src/platform/shell/dropResolution.test.ts` with cases: drop on `group-header:<g.id>` (empty group, non-empty group), drop on `__ungrouped__` (with and without ungrouped members), drop on a row in same group (above and below dragging), drop on a row in another group, drop on self (returns null), drop on unknown id (returns null)
- [x] 5.2 Run `pnpm test src/platform/shell/dropResolution.test.ts` and confirm green

## 6. Tests — integration (Vitest + RTL)

- [x] 6.1 Add `src/platform/shell/Sidebar.dnd.test.tsx` that mounts `Sidebar` with mocked `useConnections` (one ungrouped connection), `useConnectionGroups` (one empty group "Production"), and a spy on `move`
- [x] 6.2 Synthesize a `DragEndEvent` with `active.id = <connectionId>` and `over.id = "group-header:<groupId>"` by directly invoking the `DndContext`'s `onDragEnd` (extract via `getByTestId` or by attaching a ref) — avoid real pointer events for jsdom stability
- [x] 6.3 Assert `move` was called once with `{ group_id: <groupId>, sort_order: <number> }`
- [x] 6.4 Add a parallel scenario for "drop on `__ungrouped__`" from a grouped connection
- [x] 6.5 Run `pnpm test` and confirm all suites green (incl. existing `useExpandedGroups`, `sortOrder`, `dropResolution`)

## 7. Lint, type-check, and build

- [x] 7.1 Run `pnpm tsc --noEmit` — clean
- [x] 7.2 Run `pnpm eslint .` — no new warnings beyond pre-existing baseline
- [x] 7.3 Run `cargo check` from `src-tauri/` — unchanged but confirm

## 8. Manual smoke test (covers parent change's deferred 8.4)

- [x] 8.1 Start `pnpm tauri dev` against a database with at least one group and at least one ungrouped connection
- [x] 8.2 Drag an ungrouped connection onto an **empty** group's header — verify it moves and persists across restart
- [x] 8.3 Drag a connection from group A to a position **inside** group B (between members) — verify the new sort_order is correct
- [x] 8.4 Drag a connection from group A onto group B's **header** with B non-empty — verify it appends at the end
- [x] 8.5 Drag a connection from a group onto the **ungrouped header** — verify it moves to ungrouped (this also exercises the new `useDroppable`)
- [x] 8.6 Reorder groups by dragging a group header — verify only group order changes, not connection order
- [x] 8.7 Try keyboard drag (Tab to a row, Space to grab, Arrow keys, Space to drop) across a section boundary — verify the announcement and move
- [x] 8.8 Try dragging a group and releasing on a connection row — verify nothing happens (D7 guard)

## 9. Document

- [x] 9.1 In `tasks.md` of the parent `connection-groups` change, mark task 8.4 (the deferred manual smoke) as covered by this change's section 8 — leave a one-line note linking here
- [x] 9.2 No CHANGELOG entry in this repo; the parent change owns the user-facing entry once both archive together
