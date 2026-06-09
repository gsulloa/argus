## 1. Shared clipboard helper

- [x] 1.1 Create `src/lib/grid/cellClipboard.ts` exporting `formatCellValue(value): string` (NULL → "", boolean → `true`/`false`, object/array → `JSON.stringify`, binary/truncated envelope → preview, else String(value)) and `copyCellValue(value): Promise<void>` (format + `navigator.clipboard.writeText`, errors swallowed/logged).
- [x] 1.2 Add unit tests for `formatCellValue` covering null, boolean, number, string, object/array, and binary/truncated-preview cases.

## 2. Postgres grid (editable)

- [x] 2.1 Add `activeCell: { row, col } | null` selection state in `TableViewerTab.tsx`, mutually exclusive with the existing row `{ anchor, active }` (setting one clears the other); reset on sort/filter/page/refresh and on Escape.
- [x] 2.2 In `data/DataGrid.tsx`, set the active cell on single click and render a focus ring (per `DESIGN.md`); ensure the scroll container is focusable (`tabIndex={0}`) and gains focus on cell click.
- [x] 2.3 Extend `onGridKeyDown` (~185-225) to handle `(metaKey||ctrlKey) && key==='c'`: when `activeCell` is set and the event target is not an input/textarea/select, `preventDefault()` and `copyCellValue(cellValue)`.
- [x] 2.4 Verify `EditableCell.tsx` double-click → edit is unchanged and ⌘C inside an open editor copies the input's selected text (not intercepted).

## 3. MySQL grid (editable)

- [x] 3.1 Add `activeCell` state in `data/DataGrid.tsx` (mutually exclusive with row range); set on single click with focus ring; clear on Escape/data change.
- [x] 3.2 Add the cell-copy keydown handler (cell active + non-input target → `copyCellValue`).
- [x] 3.3 Make the existing `window` `"copy"` row-range listener (~144-164) early-return when `activeCell` is set, so cell copy takes precedence; replace local `cellToString` with `formatCellValue`.

## 4. MSSQL grid (editable)

- [x] 4.1 Mirror MySQL: add `activeCell` state, single-click selection + focus ring, Escape/data-change clearing in `data/DataGrid.tsx`.
- [x] 4.2 Add the cell-copy keydown handler with precedence over the row-range `"copy"` listener (~146-166); replace local `cellToString` with `formatCellValue`.

## 5. Read-only grids

- [x] 5.1 Add `activeCell` state + single-click selection + focus ring + ⌘C copy to Postgres `data/AdhocResultGrid.tsx` (no edit mode).
- [x] 5.2 Add `activeCell` state + single-click selection + focus ring + ⌘C copy to the Athena `SimpleTable` in `sql/ResultPanel.tsx` (no edit mode).

## 6. Verification

- [x] 6.1 Manually QA each grid (Postgres, MySQL, MSSQL, Athena editable + read-only): click an `id` cell, press ⌘C, confirm only that value is on the clipboard.
- [x] 6.2 Confirm row-range TSV copy still works in MySQL/MSSQL when a multi-row range (no single cell) is selected.
- [x] 6.3 Confirm ⌘C inside an open editor copies selected input text; confirm Escape clears the active cell and focus ring matches `DESIGN.md`.
- [x] 6.4 Run typecheck/lint and the front-end test suite.
