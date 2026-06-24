## 1. Postgres grid

- [x] 1.1 In `packages/app/src/modules/postgres/data/DataGrid.tsx`, add a `Cmd/Ctrl+A` branch to `onGridKeyDown` (before the `Escape` branch) that reuses the existing editable-target guard used by the `Cmd+C` handler.
- [x] 1.2 In the branch: if focus is in an editable target, return (let native select-all apply); if no selection is active (`selection.anchor === null && activeCell === null`) or `rows.length === 0`, return without `preventDefault`.
- [x] 1.3 Otherwise call `e.preventDefault()`, `onActiveCellChange(null)`, then `onSelectionChange({ anchor: 0, active: rows.length - 1 })`.

## 2. MySQL grid

- [x] 2.1 Apply the identical `Cmd/Ctrl+A` branch to `onGridKeyDown` in `packages/app/src/modules/mysql/data/DataGrid.tsx`, adjusting only local variable names if they differ.

## 3. MSSQL grid

- [x] 3.1 Apply the identical `Cmd/Ctrl+A` branch to `onGridKeyDown` in `packages/app/src/modules/mssql/data/DataGrid.tsx`, adjusting only local variable names if they differ.

## 4. Verify

- [x] 4.1 Build/typecheck the app frontend with no new errors.
- [x] 4.2 Manually verify in the running app (active engine Postgres): with one row selected, `Cmd+A` selects all loaded rows; with an active cell, `Cmd+A` collapses to a full row range; with no selection, `Cmd+A` still does native select-all; inside an open cell editor, `Cmd+A` selects editor text only.
- [x] 4.3 Spot-check the same flows on a MySQL and an MSSQL connection.
