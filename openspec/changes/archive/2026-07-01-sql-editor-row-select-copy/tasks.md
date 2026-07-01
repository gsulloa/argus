## 1. Row-range selection state in `AdhocResultGrid`

- [x] 1.1 In `packages/app/src/modules/postgres/data/AdhocResultGrid.tsx`, add internal `selection: { anchor: number | null; active: number | null }` state alongside the existing `activeCell`, keeping the two mutually exclusive (setting a row range clears `activeCell`; setting `activeCell` clears `selection`).
- [x] 1.2 Replace the vestigial `selectedRowIndex` / `onSelectRow` props with `onSelectionChange?(sel: { anchor: number | null; active: number | null }): void` (report selection changes outward). Update the `AdhocResultGridProps` type and the outer→inner prop pass-through.
- [x] 1.3 Clear `selection` (and `activeCell`) when the dataset changes, matching the existing `activeCell` reset effect (`[columns, rows]`).

## 2. Row-number gutter + selection gestures

- [x] 2.1 Add a `GUTTER_WIDTH` (32px) leading column to the header row and each virtualized data row, rendering the 1-based display index; include gutter width in `effectiveTotalWidth` / header width (`totalWidth + GUTTER_WIDTH`), mirroring `DataGrid.tsx`.
- [x] 2.2 Style the gutter cell/header using the existing `DataGrid.module.css` classes (`gutterHeader`, `gutterCell`) with pointer cursor + hover affordance; render selected rows with the existing `data-selected` / selected-row styling.
- [x] 2.3 Wire gutter mousedown handlers copied structurally from `DataGrid.tsx`: plain click → `{ anchor: i, active: i }` and clear active cell; shift-click (when an anchor exists) → `{ anchor, active: i }`.
- [x] 2.4 Implement drag-to-select on the gutter using `pixelYToRowIndex` from `postgres/data/dragRowIndex.ts` (update `active` on drag, with auto-scroll near viewport edges), matching `DataGrid.tsx`. Ensure the grid retains keyboard focus after a gutter interaction so ⌘C works without an extra click.

## 3. Keyboard: copy + select-all

- [x] 3.1 Replace the direct `copyCellValue` call in `onGridKeyDown` with the shared `copyCell(value, onCopyError)` from `@/platform/grid/gridCopy` for the single-cell path.
- [x] 3.2 Add the row-range copy path in `onGridKeyDown` via `copyRowRangeFromKeydown(e, { editing: false, activeCell, selection, columnNames: columns.map(c => c.name), resolveRow: (i) => rows[i] ?? null, write: writeClipboardText, onError })`; keep it mutually exclusive with single-cell copy and skip when focus is in a text input.
- [x] 3.3 Add ⌘A / Ctrl+A handling: when a selection or active cell exists and rows are loaded, set `{ anchor: 0, active: rows.length - 1 }`, clear `activeCell`, and `preventDefault`; stay inert (no `preventDefault`) when nothing is selected or there are no rows.
- [x] 3.4 Surface clipboard failures via a toast `onCopyError` (reuse `useToast` as `DataGrid.tsx` does).

## 4. Read-only Copy-only context menu

- [x] 4.1 Generalize `packages/app/src/modules/postgres/data/RowContextMenu.tsx` with an opt-in prop (e.g. `copyOnly`) that hides the Edit cell and Delete/Restore row(s) items and their separator; default behavior (editable grid) unchanged.
- [x] 4.2 Wrap the ad-hoc grid rows in the `RowContextMenu` (copy-only) with `onCopyCell` → single-cell copy and `onCopyRows` → row-range copy; implement target resolution (right-click outside selection retargets to that single row; inside an active multi-row selection keeps the range) and `isMulti` label pluralization.

## 5. Wire selection into the SQL editor inspector

- [x] 5.1 In `packages/app/src/modules/postgres/sql/ResultPanel.tsx`, replace `selectedRow: number | null` state with the grid's `selection` (anchor/active) via `onSelectionChange`.
- [x] 5.2 Compute selected row indices (`[min..max]`) from `selection` and pass the corresponding `sortedRows` to `RowInspector`'s `selectedRows` array; clear the inspector when a single cell is active (empty selection). Preserve single-row behavior as the common case.

## 6. Tests

- [x] 6.1 Add `AdhocResultGrid.copy.test.tsx` mirroring `DataGrid.copy.test.tsx`: single-cell ⌘C, row-range ⌘C (multi-row and single-row), mutual exclusivity, and byte-identical TSV vs the editable grid.
- [x] 6.2 Add tests for gutter selection (plain click, shift-click extend, drag range) and ⌘A select-all (extend + inert-without-selection cases).
- [x] 6.3 Add `AdhocResultGrid.contextMenu.test.tsx` mirroring `DataGrid.contextMenu.test.tsx`: menu shows only Copy cell / Copy row(s), retarget-outside vs keep-inside selection, and Copy actions match ⌘C output.
- [x] 6.4 Add a `ResultPanel` test asserting a multi-row gutter selection drives the inspector's `selectedRows`.
- [x] 6.5 Confirm existing `AdhocResultGrid.resize.test.tsx` and `DataGrid.contextMenu.test.tsx` still pass (gutter width + `RowContextMenu` generalization).

## 7. Verify

- [x] 7.1 Run `pnpm -C packages/app test` (or the repo's Vitest command) and lint/typecheck; fix any fallout from the `AdhocResultGridProps` prop change.
- [x] 7.2 Manual check in the packaged/dev app: run a SELECT, select a row range from the gutter, ⌘C, paste into a text editor and confirm TSV; verify ⌘A, the Copy-only context menu, and inspector population for single- and multi-row selections.
- [x] 7.3 Confirm no visual regressions against `DESIGN.md` (gutter, selection highlight, context-menu styling).
