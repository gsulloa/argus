## Why

After running a query in the SQL editor, the result grid cannot be sorted by clicking column headers (issue #91). The table browser supports this, so users reasonably expect the same affordance on SQL results — but the SQL result grids are inconsistent and broken: MySQL/MSSQL pass `orderBy={[]}` with a no-op `onSortChange`, while Postgres (`AdhocResultGrid`) and Athena (`SimpleTable`) render plain read-only tables with no sort UI at all. The table browser's sort is **server-side** (re-query with `ORDER BY` against the table's schema context), which an arbitrary SQL result set does not have, so it cannot be reused as-is.

## What Changes

- Introduce **client-side sorting** over the already-loaded SQL result set, applied uniformly across all four engines' SQL editors (Postgres, MySQL, MSSQL, Athena).
- Add a shared, presentation-only sort utility: stable sort, deterministic `null`/`undefined` ordering, and value-aware comparison (numeric vs. date vs. text) so columns sort the way a user expects regardless of cell envelope type.
- Wire click-to-sort on column headers with the three-state cycle **asc → desc → unsorted** and a visible ↑/↓ direction indicator, matching the existing table-browser interaction.
- Apply this to each engine's SQL result grid:
  - **MySQL / MSSQL**: replace the hardcoded `orderBy={[]}` / no-op `onSortChange` in their SQL `ResultPanel` with local sort state that reorders rows client-side before handing them to the grid.
  - **Postgres** `AdhocResultGrid` and **Athena** `SimpleTable`: add header click-to-sort, indicators, and client-side reordering (these are currently intentionally presentational).
- Sorting is purely visual: it never re-queries the database and never mutates the underlying result, so it works identically on read-only engines including Athena.

## Capabilities

### New Capabilities
- `sql-result-sorting`: Client-side, presentation-only sorting of SQL editor result grids across all engines — header click-to-sort with asc/desc/unsorted cycling, direction indicators, stable ordering, and type/null-aware comparison, without re-querying the source.

### Modified Capabilities
<!-- None. The new capability augments the "Result panel for rows and affected outcomes" requirement in mysql-sql-editor, mssql-sql-editor, postgres-sql-editor, and athena-sql-editor by adding a sort affordance to the already-loaded result; no existing requirement's contract is removed or changed. -->

## Impact

- **New shared util** (frontend): a presentation sort helper usable by every SQL result grid (e.g. `src/modules/<shared>/sortResultRows.ts`), covering stable sort, null handling, and numeric/date/text comparison from the `Value` envelope.
- **MySQL**: `src/modules/mysql/sql/ResultPanel.tsx` (~215–237) — add `orderBy` state + working `onSortChange`, sort `unifiedRows` client-side.
- **MSSQL**: `src/modules/mssql/sql/ResultPanel.tsx` (~211–234) — same wiring as MySQL.
- **Postgres**: `src/modules/postgres/sql/ResultPanel.tsx` + `src/modules/postgres/data/AdhocResultGrid.tsx` — add header click-to-sort, indicators, and client-side reorder to the currently presentational grid.
- **Athena**: `src/modules/athena/sql/ResultPanel.tsx` (`SimpleTable`, ~226–314) — add `<th>` click-to-sort, ↑/↓ indicators, and client-side reorder.
- **Specs touched in prose** (no contract removed): the per-engine "Result panel for rows and affected outcomes" requirements in `mysql-sql-editor`, `mssql-sql-editor`, `postgres-sql-editor`, and `athena-sql-editor`.
- No backend, no Tauri command, and no schema changes. Existing server-side table-browser sort is untouched.
