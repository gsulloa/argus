## Why

When a user has selected a cell or row range in a data grid and presses `Cmd+A` (macOS) / `Ctrl+A`, the shortcut falls through to the browser default and selects all the text in the application chrome instead of the rows in the grid. Users expect `Cmd+A` to extend their grid selection to every row, the same way it works in any spreadsheet or table tool.

## What Changes

- When the data grid holds keyboard focus **and** a selection is already active (a single active cell or a row range), `Cmd+A` / `Ctrl+A` selects **all rows** currently loaded in the grid and prevents the browser's default select-all-text behavior.
- Because row-range and single-cell selection are mutually exclusive, selecting all collapses the active cell (if any) into a full row-range selection `{ anchor: 0, active: lastRowIndex }`.
- The shortcut is a no-op (and does **not** swallow the default) when nothing is selected in the grid, when the grid is empty, or when focus is inside an inline cell editor / text input — preserving normal text select-all everywhere else.
- Applies uniformly to the editable data grids that share the anchor/active row-range model: **Postgres, MySQL, and MSSQL**.

## Capabilities

### New Capabilities
- `grid-select-all`: Cross-engine "select all rows" behavior in the data grid via `Cmd+A` / `Ctrl+A`, gated on an existing grid selection and grid focus, layered on top of the per-engine row-range selection model without disturbing copy, inline editing, or other shortcuts.

### Modified Capabilities
<!-- No spec-level requirement changes to existing capabilities; row-range selection, cell copy, and existing shortcuts are unchanged. -->

## Impact

- Affected code (frontend only, no backend changes):
  - `packages/app/src/modules/postgres/data/DataGrid.tsx` — `onGridKeyDown` handler.
  - `packages/app/src/modules/mysql/data/DataGrid.tsx` — forked handler.
  - `packages/app/src/modules/mssql/data/DataGrid.tsx` — forked handler.
- No changes to Tauri commands, persistence, or AI/context-folder paths.
- Out of scope: DynamoDB (`dynamo/data-view/TabView.tsx`) uses a Set-based selection model and TanStack Table — not covered here. Read-only result grids (Athena `SimpleTable`, `AdhocResultGrid`) without row-range selection are also out of scope.
