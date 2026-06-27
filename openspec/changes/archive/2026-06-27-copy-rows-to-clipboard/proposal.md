## Why

A user reported they can't copy a whole row (issue #196). The behaviour is inconsistent across engines: **MySQL and MSSQL** already copy a selected row range as TSV (via a `window` `copy` listener), but **Postgres** does not — selecting rows and pressing ⌘C in the Postgres grid does nothing. On top of that, the existing MySQL/MSSQL row copy serialises raw **server** values and ignores pending in-buffer edits, so a copied row can silently disagree with what the user sees on screen. We want one consistent, edit-aware row copy across all three editable grids.

## What Changes

- Add a shared `formatRowsTSV(rows)` helper to `cellClipboard.ts` that serialises an array of rows (each an array of cell values) to tab-separated text — one row per line, cells joined by `\t` — reusing the existing `formatCellValue` so cell formatting is identical to single-cell copy.
- **Postgres grid**: add row-range copy. When a row range is selected and no single cell is active, ⌘C/Ctrl+C copies the selected rows as TSV (mirroring the MySQL/MSSQL `copy`-listener pattern). Single-cell copy precedence is unchanged.
- **MySQL & MSSQL grids**: refactor their inline TSV logic to use the shared `formatRowsTSV` helper (de-duplication, no behaviour change to the TSV shape itself).
- **All three editable grids**: copied row values MUST reflect pending in-buffer edits (the same display-value resolution already used by single-cell copy), not raw server values.
- Default and documented clipboard format is **TSV without a header row** (pasteable into spreadsheets), matching the issue's acceptance criterion. SQL/JSON export, a context-menu entry, and row duplication are explicitly out of scope for this change.

## Capabilities

### New Capabilities
- `grid-row-copy`: Selecting one or more rows in any editable data grid (Postgres, MySQL, MSSQL) and copying them to the system clipboard as tab-separated values via ⌘C/Ctrl+C, with pending edits reflected and cell formatting identical to single-cell copy.

### Modified Capabilities
<!-- None. grid-cell-copy already specifies the cell-vs-row precedence and the shared formatter; its requirements do not change. -->

## Impact

- `packages/app/src/platform/grid/cellClipboard.ts` — new `formatRowsTSV` helper (+ tests in `cellClipboard.test.ts`).
- `packages/app/src/modules/postgres/data/DataGrid.tsx` — add a `window` `copy` listener for edit-aware row-range TSV copy.
- `packages/app/src/modules/mysql/data/DataGrid.tsx`, `packages/app/src/modules/mssql/data/DataGrid.tsx` — route existing row copy through `formatRowsTSV`; resolve edited (display) values per cell.
- Read-only grids (`AdhocResultGrid`, Athena `SimpleTable`, CloudWatch `InsightsTable`) are out of scope: they have no row-range selection model, only single-cell selection.
- No backend, schema, or dependency changes. No breaking changes.
