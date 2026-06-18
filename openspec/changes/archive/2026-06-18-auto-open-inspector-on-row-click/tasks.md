## 1. MySQL viewer auto-reveal

- [x] 1.1 In `packages/app/src/modules/mysql/data/TableViewerTab.tsx`, replace the no-op `onCellSelect={(_rowIdx, _colIdx) => { ... }}` handler (around line 664) so it calls `setInspectorVisible(true)` on every cell-select. Keep the existing comment intent (colIdx still ignored).
- [x] 1.2 Confirm no `DataGrid.tsx` change is needed: `onCellSelect` already fires on plain click, shift-click, and double-click edit-start (lines 188, 427), and is NOT fired by header sort (calls `onSortChange`), resize, scroll, or toolbar handlers.

## 2. MSSQL viewer auto-reveal

- [x] 2.1 In `packages/app/src/modules/mssql/data/TableViewerTab.tsx`, replace the no-op `onCellSelect={(_rowIdx, _colIdx) => { ... }}` handler (around line 759) so it calls `setInspectorVisible(true)` on every cell-select, mirroring the MySQL change.
- [x] 2.2 Confirm the MSSQL `DataGrid.tsx` requires no change (same `onCellSelect` invocation pattern as MySQL).

## 3. Verify excluded engines need no change

- [x] 3.1 Confirm Postgres (`postgres/data/TableViewerTab.tsx`) renders the inspector permanently with no `inspectorVisible` toggle (0 occurrences) — no change required.
- [x] 3.2 Confirm DynamoDB (`dynamo/data-view/DataViewTab.tsx`) already focuses the always-docked inspector on row/complex-cell selection per the `dynamo-data-view` spec — no change required.

## 4. Manual QA against acceptance criteria

- [x] 4.1 MySQL: with the inspector toggled off, click a row → inspector reveals and shows that row.
- [x] 4.2 MySQL: click another row → inspector updates without closing; toggle off then click again → re-reveals.
- [x] 4.3 MySQL: click a column header to sort, drag-resize a column, scroll, and use a toolbar button while the inspector is hidden → it stays hidden.
- [x] 4.4 MySQL: shift-click a row range while hidden → inspector reveals in multi-row mode; verify inline editing is not interrupted.
- [x] 4.5 Repeat 4.1–4.4 for MSSQL to confirm consistent behavior.
