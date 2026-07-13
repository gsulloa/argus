## Why

In the Postgres data grid, double-clicking a cell enters inline edit mode with the text auto-selected. If the user then clicks inside the text to reposition the caret and edit a specific part of the value, the cell exits edit mode instead of moving the caret (issue #246). This makes it impossible to edit a portion of a value without re-entering edit mode, and it silently commits whatever was in the editor.

The root cause: the grid's virtualized row `onMouseDown` handler (drag-to-select-rows) fires for *any* primary-button mousedown inside the row — including a mousedown inside the active editor input. It calls `preventDefault()` (suppressing native caret placement) and arms the drag machinery, which installs a `document` `mouseup` listener that steals focus back to the grid root. That blur fires the editor's `onBlur → commit`, exiting edit mode.

## What Changes

- A primary-button mousedown that originates inside the **active inline cell editor** no longer engages the grid's row drag-to-select machinery. The editor swallows the mousedown so the row-level handler stays inert.
- As a result, clicking inside the editor text repositions the caret (native behaviour) without exiting edit mode, and click-dragging inside the editor selects a substring without arming row-range selection or stealing focus.
- No change to double-click-to-edit, single-click row selection, drag-to-select on display cells, commit-on-Enter/Tab, cancel-on-Escape, or the NULL-toggle button behaviour.

Scope note: MySQL and MSSQL grids do not have a row-level `onMouseDown` drag-select handler (they select via `onClick`, which does not clear the editing cell and does not `preventDefault` caret placement), so they do not exhibit this bug and are out of scope. DynamoDB already guards its inline editor with `stopPropagation` and is unaffected.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `postgres-data-grid`: the "Drag-to-select row range" requirement is clarified so that a mousedown originating inside the active inline editor keeps the row drag-select handler inert (via the editor's `stopPropagation`), and a new scenario asserts that a single click inside the editor repositions the caret without exiting edit mode.

## Impact

- Affected code: `packages/app/src/modules/postgres/data/EditableCell.tsx` (edit-path wrapper `.cellEditing` gains a `stopPropagation` mousedown guard). No change to `DataGrid.tsx` behaviour is required — stopping the mousedown at the editor wrapper prevents the row handler from ever arming drag.
- Affected spec: `openspec/specs/postgres-data-grid/spec.md`.
- Tests: `packages/app/src/modules/postgres/data/__tests__/` (new coverage that clicking inside the active editor does not exit edit mode).
- No backend, API, schema, or dependency changes.
