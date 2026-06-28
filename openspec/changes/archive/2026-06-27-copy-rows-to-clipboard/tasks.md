## 1. Shared formatter

- [x] 1.1 Add `formatRowsTSV(rows: unknown[][]): string` to `packages/app/src/platform/grid/cellClipboard.ts`, mapping each row through the existing `formatCellValue`, joining cells with `\t` and rows with `\n`.
- [x] 1.2 Add unit tests in `cellClipboard.test.ts`: mixed values in one row (number, NULL→empty, boolean, object→JSON), multiple rows joined by `\n`, single-row case, empty-rows case.

## 2. Postgres grid — add row-range copy

- [x] 2.1 In `packages/app/src/modules/postgres/data/DataGrid.tsx`, add a `useEffect` registering `window.addEventListener("copy", handleCopy)` (with cleanup), guarded to early-return when `activeCell !== null` or `selection.anchor`/`selection.active` is null.
- [x] 2.2 In `handleCopy`, resolve the row range `[min, max]`, build an edit-resolved `unknown[][]` (per cell: use `buffer.getRowEdits(rowKey)` edited value when the column name is in `changes`, else the server cell; fall back to raw `cells` when `rowKey` is missing), then `e.clipboardData?.setData("text/plain", formatRowsTSV(resolved))` and `e.preventDefault()`.
- [x] 2.3 Set the effect dependency array to `[selection, rows, activeCell, columns, buffer]`.

## 3. MySQL & MSSQL grids — share formatter + edit-awareness

- [x] 3.1 In `packages/app/src/modules/mysql/data/DataGrid.tsx`, replace the inline `lines.push(row.cells.map(formatCellValue).join("\t"))` logic in the `copy` listener with a build of an edit-resolved `unknown[][]` (per cell via `buffer.getDisplayValue(rowKey, cells, columnNames, colName)`) passed to `formatRowsTSV`.
- [x] 3.2 Apply the same change in `packages/app/src/modules/mssql/data/DataGrid.tsx`.
- [x] 3.3 Ensure both effects' dependency arrays include `buffer`/`columns` as needed so edit-resolution doesn't read stale state.

## 4. Verification

- [x] 4.1 Manually verify in each editable grid: drag-select a multi-row range, ⌘C, paste into a spreadsheet → one row per line, tab-separated, correct column order.
- [x] 4.2 Verify a row with a pending edit copies the edited value (not the server value) in all three grids.
- [x] 4.3 Verify single-cell copy still wins when a cell is active, and that ⌘C inside an open editor performs native text copy (no row TSV).
- [x] 4.4 Run the workspace lint/typecheck and the `cellClipboard` unit tests. (typecheck: 0 errors; test:run: 1465 passed; eslint on changed files: clean.)
