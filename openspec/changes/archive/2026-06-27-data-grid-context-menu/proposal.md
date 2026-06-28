## Why

Users report they "can't copy / edit / delete rows" in the data grid, even though all three actions exist — they're hidden behind keyboard shortcuts (double-click/Enter to edit, Backspace/Delete to delete, ⌘C to copy a cell) with no visible affordance. In TablePlus every one of these is one right-click away, so the absence of a context menu reads as "the feature is missing." This is a discoverability gap (GitHub #197), not a missing capability.

## What Changes

- Add a **right-click context menu** to the editable data grid (Postgres, MySQL, MSSQL) that surfaces the common row/cell actions in one place.
- Menu actions, each dispatching the **exact same logic** as the existing keyboard shortcuts/handlers:
  - **Copy cell** — formatted value of the cell under the cursor (reuses cell-copy formatting).
  - **Copy row(s)** — TSV of the targeted row, or of the whole selection when multiple rows are selected (relates to #196).
  - **Edit cell** — enters inline edit mode on the targeted cell (same as double-click/Enter).
  - **Delete row(s) / Restore row(s)** — toggles delete on the targeted row or the whole selection (same as Backspace/Delete), labelled to reflect current state.
- Right-clicking a row that is **outside** the current selection retargets the menu to that row (cell/row under the cursor becomes the target); right-clicking **inside** the current multi-row selection keeps the selection as the action target.
- Respect read-only / no-PK state: inapplicable actions are **disabled with an explanatory tooltip** rather than hidden, so the user understands *why* an action is unavailable.
- Style the menu per `DESIGN.md`, reusing the existing Radix menu primitive and tokens already used by the sidebar context menus.

## Capabilities

### New Capabilities
- `grid-context-menu`: Right-click context menu on the row-range-capable editable data grids (Postgres/MySQL/MSSQL) exposing copy-cell, copy-row(s), edit-cell, and delete/restore-row(s); retargeting rules; and disabled-with-tooltip behaviour for read-only / no-PK states.

### Modified Capabilities
<!-- No existing spec-level requirements change; the menu only invokes existing behaviours. -->

## Impact

- **Code (new):** a `RowContextMenu` component + module CSS under `packages/app/src/modules/postgres/data/` (shared by the editable grid); a small `copyRowsTsv` helper alongside `cellClipboard.ts` for multi-row TSV copy.
- **Code (modified):** `packages/app/src/modules/postgres/data/DataGrid.tsx` — wrap rows in a context-menu trigger, resolve the right-clicked row/cell, and wire menu items to the existing `onActiveCellChange`, edit-start, `buffer.bulkDeleteToggle`, and copy paths. The shared `DataGrid` is consumed by the MySQL and MSSQL data tabs, so the menu appears there too.
- **Dependencies:** none new — `@radix-ui/react-context-menu` is already a dependency.
- **Out of scope:** read-only result grids (`AdhocResultGrid`, Athena/CloudWatch result tables) and the optional "Duplicate row" action are not included in this change.
