## 1. Shared helpers (extract & reuse)

- [x] 1.1 Add `copyRowsTsv(rows, columns)` to `packages/app/src/platform/grid/cellClipboard.ts` (joins cells with `\t`, rows with `\n`, formatting each cell via existing `formatCellValue`; writes via `navigator.clipboard.writeText`, swallowing errors like `copyCellValue`).
- [x] 1.2 In `DataGrid.tsx`, extract the delete-entry-building loop currently inside the `Backspace`/`Delete` branch into a pure helper `buildDeleteEntries(rangeStart, rangeEnd)` and call it from `onGridKeyDown` (no behaviour change — verify keyboard delete still works).
- [x] 1.3 In `DataGrid.tsx`, extract the buffer-aware cell display-value lookup (from the ⌘C branch) into a helper `resolveCellDisplayValue(rowIndex, colIndex)` and call it from the existing ⌘C copy path (no behaviour change).

## 2. RowContextMenu component

- [x] 2.1 Create `packages/app/src/modules/postgres/data/RowContextMenu.tsx` using `@radix-ui/react-context-menu`, with `RowContextMenu.module.css` styled per `DESIGN.md` (reuse the existing `styles.contextMenu` token conventions from the shell menus — borders, radius, accent).
- [x] 2.2 Define its props: target context (`{ rowIndex, colIndex }`), `isMulti` flag, enabled-state flags (`canEditCell`, `canDeleteRows`, `deleteIsRestore`), disabled-reason strings, and `onCopyCell` / `onCopyRows` / `onEditCell` / `onToggleDelete` callbacks.
- [x] 2.3 Render items Copy cell, Copy row(s), Edit cell, Delete row(s)/Restore row(s); pluralize labels from `isMulti`; render disabled items with an explanatory tooltip (project tooltip pattern / `title`).

## 3. Wire the menu into DataGrid

- [x] 3.1 Wrap each virtualized row (or the grid body) with the Radix `ContextMenu.Trigger`; on `onContextMenu`, resolve the clicked column from the nearest `[data-col]` element (mirror the existing `onMouseDown` resolution).
- [x] 3.2 Implement target retargeting: if the right-clicked row is outside the current `selection` range, call `onActiveCellChange({ row, col })` + `onSelectionChange({ anchor: null, active: null })`; if inside the range, leave selection untouched. Derive `isMulti` from the effective target.
- [x] 3.3 Compute enabled-state for the menu from existing logic: `canEditCell` from the same `cellReadOnly` computation + `!bulkEditActive`; `canDeleteRows` from `!isReadOnly` and at least one deletable targeted row (insert always; server only when `pkColumns != null`); `deleteIsRestore` when every targeted row is `buffer.isRowDeleted`.
- [x] 3.4 Wire callbacks to existing paths: Copy cell → `copyCellValue(resolveCellDisplayValue(...))`; Copy row(s) → `copyRowsTsv(targetRows, columns)`; Edit cell → `setEditing({ rowIndex, col })` (respect `bulkEditActive`); Delete/Restore → `buffer.bulkDeleteToggle(buildDeleteEntries(...))`.

## 4. Tests

- [x] 4.1 Unit test `copyRowsTsv` formatting (null→empty, boolean, object/array JSON, multi-row/multi-column joins).
- [x] 4.2 Component tests on `DataGrid`: right-click opens menu; Copy cell output equals the ⌘C path; Edit cell enters edit mode equal to double-click; Delete toggles the buffer equal to Backspace; menu dismisses on Escape.
- [x] 4.3 Component tests for target resolution: right-click outside selection retargets to the clicked row; right-click inside a multi-row selection keeps it and acts on all rows.
- [x] 4.4 Component tests for disabled states: read-only grid disables Edit/Delete (copy enabled); no-PK relation disables server-row delete; PK/non-editable cell disables Edit — each with its tooltip.

## 5. Verify across engines & design

- [x] 5.1 Confirm the menu renders and works in the MySQL and MSSQL data tabs (shared `DataGrid`), and is NOT present in read-only result grids (`AdhocResultGrid`, Athena/CloudWatch).
- [x] 5.2 Run lint/typecheck and the app; manually verify against `DESIGN.md` (no thick borders, correct accent/radius, tooltip copy reads in project voice).
