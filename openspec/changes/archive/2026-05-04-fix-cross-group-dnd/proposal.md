## Why

Manual testing of `connection-groups` exposed a regression: a user can reorder connections inside a group and reorder the groups themselves, but **cannot drag a connection from "Ungrouped" into another group when that group is empty** (and, by the same root cause, cannot drag a connection across any two sections at all). The sidebar wraps each group's connections — and the ungrouped list — in its own `DndContext`. `@dnd-kit` isolates droppable detection per `DndContext`, so a draggable started in the ungrouped section never sees any other group's `GroupHeader` or its sortable list, and an empty group has no draggable members to fall back onto. The bug breaks the headline use case of the feature: organizing existing ungrouped connections into newly created groups.

## What Changes

- Collapse the sidebar's nested `DndContext`s into a single `DndContext` that wraps the entire connections section so cross-section drags are detected.
- Introduce typed, prefixed droppable IDs (`connection:<id>`, `group-header:<id>`, `group-sortable:<id>`, plus the existing `__ungrouped__`) and a single `onDragEnd` dispatcher that routes by the active id's prefix to either group reordering or connection moving.
- Make every group header — including empty ones — a first-class drop target that resolves to "append at end of this group" when no member row is hit.
- Add regression coverage: a unit test on the dispatcher's drop-resolution logic, and a Vitest scenario for "drag an ungrouped connection onto an empty group's header".
- Do not change any Tauri command, SQL schema, or persisted data shape.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `connection-groups`: add a scenario to the existing "Drag and drop reorders and re-parents connections" requirement that explicitly covers dropping onto an empty group's header. The requirement text already promises cross-group moves; the new scenario locks in the failing edge case so it cannot regress.

## Impact

- **Code**: `src/platform/shell/Sidebar.tsx` (rewritten DnD wiring, single dispatcher), small touch to `src/platform/shell/GroupHeader.tsx` (drop-target wiring already exists; verify it's the only droppable on empty groups), no change to `ConnectionRow.tsx` IDs.
- **Tests**: new unit test for the drop-resolution helper; new Vitest test that simulates the ungrouped → empty-group drop end-to-end via dispatched `DragEndEvent` (jsdom-friendly, no real pointer events).
- **APIs / IPC**: unchanged. `connections.move`, `connection_groups.*` are stable.
- **Dependencies**: no new dependencies. Continues using `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`.
- **Risk**: low. Refactor stays inside one component. Deferred manual smoke test from the parent change (`connection-groups` task 8.4) can be merged into this change's QA.
