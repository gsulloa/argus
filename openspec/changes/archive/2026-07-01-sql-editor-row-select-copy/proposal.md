## Why

In the Postgres SQL editor, raw-query results render in the read-only `AdhocResultGrid`, which today supports only single-cell selection and single-cell ⌘C copy. Users cannot select whole rows or copy multiple rows out of a query result — a gap versus the editable table viewer (and versus the MySQL/MSSQL SQL editors, which already reuse the editable grid and inherit gutter row-selection + row-range copy). This makes the most common "run a SELECT, grab these rows" workflow needlessly clumsy for Postgres.

## What Changes

- Add a **row-number gutter** to the read-only `AdhocResultGrid` used by the Postgres SQL editor results, with the same selection interaction as the editable data grid: plain click selects a single row, shift-click extends the range, and drag over the gutter selects a range.
- Support **⌘C / Ctrl+C row-range copy** as TSV from the ad-hoc result grid, reusing the shared `copyRowRangeFromKeydown` path. Row-range copy remains mutually exclusive with the existing single-cell copy.
- Support **⌘A / Ctrl+A select-all** of loaded rows in the ad-hoc result grid, matching the editable grid.
- Add a **read-only right-click context menu** on the ad-hoc result grid offering **Copy cell** and **Copy row(s)** only (no Edit / Delete, since results are immutable). This reverses the prior explicit exclusion of ad-hoc SQL results from the grid context menu.
- Wire the ad-hoc grid's row-range **selection into the shell's right inspector** so a multi-row selection drives the inspector's column-value view (single-row remains the common case).
- No backend changes. No change to MySQL/MSSQL SQL editors (already covered via editable-grid reuse) or to Athena/CloudWatch result tables (custom HTML tables — out of scope, tracked as a follow-up).

## Capabilities

### New Capabilities

_None — this change broadens the scope of existing grid capabilities to the read-only ad-hoc SQL result grid._

### Modified Capabilities

- `grid-row-selection`: extend gutter-based row selection (plain / shift-click / drag) from the editable grids to the read-only ad-hoc SQL result grid (`AdhocResultGrid`).
- `grid-row-copy`: extend ⌘C / Ctrl+C row-range TSV copy to the ad-hoc SQL result grid. (The "reflects pending edits" requirement stays editable-grid-only; ad-hoc results have no edit buffer.)
- `grid-select-all`: extend ⌘A / Ctrl+A select-all-rows to the ad-hoc SQL result grid.
- `grid-context-menu`: add a **read-only variant** of the context menu (Copy cell / Copy row(s) only) on the ad-hoc SQL result grid, reversing the previous "not added to read-only result grids" exclusion for ad-hoc SQL results.
- `postgres-sql-editor`: the result panel's row selection now supports a multi-row range (not just a single row) driving the shell's right inspector, plus row-range copy and context-menu affordances.

## Impact

- **Code (frontend only):**
  - `packages/app/src/modules/postgres/data/AdhocResultGrid.tsx` — add gutter, `selection` state (anchor/active), drag-select, ⌘A / ⌘C row-range copy, context menu; keep single-cell copy.
  - `packages/app/src/modules/postgres/sql/ResultPanel.tsx` — manage row-range selection (replacing the single-`selectedRow` state) and feed selected rows to `RowInspector`.
  - Reuse of shared helpers: `@/platform/grid/gridCopy` (`copyRowRangeFromKeydown`, `copyCell`, `copyRows`), `dragRowIndex.pixelYToRowIndex`, and a read-only context-menu component (extract/reuse from `postgres/data/RowContextMenu.tsx`).
- **Tests:** new/updated Vitest coverage alongside `AdhocResultGrid.*.test.tsx`, mirroring `DataGrid.copy.test.tsx` and `DataGrid.contextMenu.test.tsx`.
- **No backend, schema, or IPC changes.** No new dependencies.
- **Out of scope:** Athena `SimpleTable` and CloudWatch `InsightsTable` (custom HTML tables; single-cell copy only) — follow-up.
