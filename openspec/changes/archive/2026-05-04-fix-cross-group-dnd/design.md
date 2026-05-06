## Context

The `connection-groups` change shipped drag-and-drop in `src/platform/shell/Sidebar.tsx`. Manual testing revealed that dragging an ungrouped connection onto another group (visibly worst with empty groups, where there's no row to drop on) does nothing. Reordering inside a group, reordering inside ungrouped, and reordering the groups themselves all work.

The current wiring (`Sidebar.tsx:271-341`) renders **three concentric `DndContext` providers**:

```
DndContext (groups, onDragEnd = handleGroupDragEnd)
  SortableContext (group-sortable:*)
    for each group g:
      DndContext (g, onDragEnd = handleConnectionDragEnd)
        SortableContext (connections in g)
          GroupHeader  ← useDroppable("group-header:<g.id>")
          ConnectionRow*  ← useSortable(<conn.id>)
  if any ungrouped:
    DndContext (ungrouped, onDragEnd = handleConnectionDragEnd)
      SortableContext (ungrouped connections)
        UngroupedHeader  ← (no useDroppable today; UNGROUPED_DROPPABLE_ID is exported but not used)
        ConnectionRow*
```

`@dnd-kit`'s `DndContext` is the boundary at which the library tracks pointer events, droppables, and collision detection. A draggable inside one `DndContext` cannot "see" droppables in a sibling. The architecture is correct for *isolating* drag behaviors but wrong for *crossing* them, and the headline use case for groups is precisely a cross-section move ("organize my flat list into folders").

Three secondary observations that fall out of the same root cause:

1. `UNGROUPED_DROPPABLE_ID` is exported and referenced in `handleConnectionDragEnd` but never registered as a `useDroppable` anywhere — `UngroupedHeader` is plain `div`. So even within a single context, dropping on the ungrouped header label currently no-ops; reorders only resolve via `useSortable` on rows.
2. `handleGroupDragEnd`'s "move group" path uses `groups.update(id, { sort_order })` per the spec. Good — no change needed.
3. `closestCenter` collision detection is the right default once everything lives in one `DndContext`; we don't need `pointerWithin` or a custom collision strategy yet.

## Goals / Non-Goals

**Goals:**

- Dragging a connection from any section (a group, or ungrouped) onto any other section's header **or** onto a row inside another section results in exactly one `connections.move` call with the new `group_id` and a `sort_order` between the destination's neighbors.
- Empty groups accept drops on their header.
- Reordering groups continues to work, untouched in behavior.
- Keyboard drag-and-drop (`KeyboardSensor`) and the screen-reader live region continue to work.
- The dispatcher's drop-resolution logic is unit-testable in isolation (jsdom-friendly).

**Non-Goals:**

- Multi-select drag (deferred from the parent change).
- Custom drop indicator visuals or insertion-line affordances.
- Cross-window drag, file drops, or any non-`@dnd-kit` source.
- Touching the IPC contract (`connections.move`, `connection_groups.update`).
- Persisting expanded state changes.

## Decisions

### D1. One `DndContext` for the whole connections section

Replace the three nested `DndContext`s with a single one wrapping both the groups list and the ungrouped section. Inside it, keep the existing two-`SortableContext` structure: one for group ordering, one per group + one for ungrouped connections. Multiple sibling `SortableContext`s under a single `DndContext` is officially supported by `@dnd-kit` and is the canonical pattern for kanban / multi-list layouts.

**Alternatives considered:**

- *Custom collision detection across nested contexts*: not possible — droppable IDs are scoped per `DndContext` by design.
- *Manual portal of droppables*: brittle; would re-implement what `DndContext` does.

### D2. Active-id prefix dispatch

A single top-level `onDragEnd(event)` inspects `String(event.active.id)`:

| Active id prefix          | Branch                                           |
|---------------------------|--------------------------------------------------|
| `group-sortable:<id>`     | group reorder → `handleGroupDragEnd(event)`     |
| anything else (raw UUID)  | connection move → `handleConnectionDragEnd(event)` |

`ConnectionRow` already uses raw `connection.id` as its sortable id, so the "anything else" branch is unambiguous. We deliberately keep the existing IDs unchanged to minimize blast radius.

**Alternatives considered:**

- *Prefix every id (`connection:<id>`)*: cleaner but forces edits across `ConnectionRow`, the active-row indicator, the context-menu, and any future consumer that expects raw ids. Not worth it for v1.

### D3. Drop-resolution helper, extracted and tested

Move the inner logic of the existing `handleConnectionDragEnd` into a pure function:

```ts
type DropTarget =
  | { kind: "group"; groupId: string | null; index: number }
  | { kind: "row"; groupId: string | null; index: number };

function resolveDropTarget(
  overId: string,
  draggingId: string,
  groups: Map<string | null, Connection[]>,
): DropTarget | null;
```

Inputs: the `over.id` returned by `@dnd-kit`, the dragging connection's id, and the precomputed `byGroup` + `ungrouped` map. Output: which target group + the index to insert at, or `null` if the drop is invalid (no `over`, or self).

This isolates the branching (`group-header:` vs `__ungrouped__` vs raw id) from the IPC call and makes the bug regress-able as a unit test that doesn't need React or `@dnd-kit` runtime.

### D4. UngroupedHeader becomes a real droppable

Wire `useDroppable({ id: UNGROUPED_DROPPABLE_ID })` into `UngroupedHeader` and use its ref as the section header's `ref`. Today, `UNGROUPED_DROPPABLE_ID` is referenced in the dispatch logic but not registered, so dragging onto the "Ungrouped" label is a silent no-op. Closes the symmetric case of D1's bug (group → ungrouped onto an empty ungrouped is impossible by definition since ungrouped is hidden when empty, but dropping on the *header* of a non-empty ungrouped should land at the end of the section — and currently doesn't).

### D5. Empty group: header is the only droppable

`GroupHeader` already calls `useDroppable({ id: "group-header:<id>" })` and merges that ref with its sortable ref via `setNodes`. With D1, this droppable is now reachable from any draggable in the connection section, so empty groups become valid drop zones for free. No new code needed beyond D1; this is just confirmation that the existing wiring is correct.

When a group is collapsed (`expanded === false`), only the header is rendered — the body is not. Drops onto a collapsed group land at `index = members.length` (append), same as drops on an empty group. The user does not see the connection move into place visually until they expand the group, which is acceptable; the announcement (`role="status"`) tells them the move happened.

### D6. Collision detection: `closestCenter` stays

With one `DndContext`, `closestCenter` works for all three flows (reorder rows, reorder groups, drop on a header). Group headers and connection rows have different sizes, but `closestCenter` resolves by the center point of each registered droppable's bounding box, so the user's pointer reliably picks the nearest one. No need for `pointerWithin` or a custom strategy.

If later we want a "drop here" insertion indicator, that's a presentation concern, not a collision concern.

### D7. Group-reorder dispatch must ignore non-group `over`

After D2, `handleGroupDragEnd` runs only when the active is a group. But `over` could legitimately be a non-group element (a row, the ungrouped header) if the user drags a group over the connections list. Today the function early-returns when `String(over.id).slice("group-sortable:".length)` doesn't match a group id, but only because the calling context is the group-only `DndContext` and that case is unreachable. Once we unify, we add an explicit guard: if `over.id` does not start with `group-sortable:`, ignore the drop (no-op rather than misroute to a connection move). Keeps the semantic — groups reorder among groups only — without surprising the user.

### D8. Active-row visual fidelity

`ConnectionRow` uses `useSortable` with `disabled: !draggable`. Under the unified context, `draggable` stays true for all rows so behavior is preserved. The drag overlay stays implicit (no `<DragOverlay>`); if the row's transform jumps across distant containers feel jarring, we can revisit by adding a `DragOverlay` later — but that's a polish task, not part of the bug fix.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| `@dnd-kit` quirk where two `SortableContext`s under one `DndContext` need stable item-id arrays. | Already memoized via `groups.items` and `byGroup` — no new memo needed, but verify keys stay stable across re-renders. |
| Reordering a group while pointer hovers over a connection row mis-fires as a connection move. | Guard in D7 (active-prefix dispatch + over-prefix check) — explicit unit test covers this. |
| The drop-resolution helper has a sign error in `dropIndex` after filtering the dragging row out. | Unit test on the helper covers four cases: drop-on-header (group, ungrouped) and drop-on-row (same-group, cross-group). |
| Keyboard drag previously only navigated within its sibling context; users may now keyboard-move across sections. This is a feature improvement, but `sortableKeyboardCoordinates` may not handle big vertical jumps gracefully. | Acceptable for v1; the announcement region tells screen readers what happened. If the visual cursor lags the focus, file a follow-up. |
| Existing Vitest test for `useExpandedGroups` and `sortOrder` continues to pass; no refactor risk to those. | Run `pnpm test` before opening PR. |

## Migration Plan

This is a UI-only refactor. No SQL migration, no IPC change, no persisted state shape change. Deploying the change:

1. Land the refactor + tests.
2. Manually verify: ungrouped → empty group, ungrouped → non-empty group, group A → group B (empty B, non-empty B), group → ungrouped, reorder within group, reorder groups, keyboard drag across sections.
3. Restart the app to confirm `sort_order` persists across reloads.

Rollback is `git revert`; nothing to undo on disk.

## Open Questions

1. **Should we add a `DragOverlay` for visual continuity across long jumps?** Default: no for v1. Add only if user reports the row "snapping" between containers feels broken.
2. **Keyboard cross-section drag UX**: arrow-down past the last row of one group should land on the next group's header. Default `sortableKeyboardCoordinates` may or may not do this elegantly — accept as-is for v1; revisit if QA flags it.
3. **Should `UngroupedHeader` also be a sortable so it could be reordered?** No — the spec explicitly forbids it ("MUST NOT be renameable, deletable, or reorderable"). Confirms D4 only adds a `useDroppable`, not a `useSortable`.
