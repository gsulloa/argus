## Why

Issue #279 (in-app feedback): *"que permita editar el valor de una celda al hacerle doble click"*.
The table viewer's data grid already supports double-click-to-edit
(`EditableCell.tsx:124`), but the SQL editor's result grid (`AdhocResultGrid`)
has no edit path at all — no `onDoubleClick` → `onStartEdit` wiring, no
`EditableCell` usage. After running `SELECT * FROM t WHERE …` the user can read
and copy the returned rows but must go find each row again in the table viewer to
change a value. Double-clicking today does nothing and gives no explanation.

Editing an ad-hoc result is only safe when the rows are *provably* traceable back
to one base table with its primary key present in the projection. Postgres already
tells us this on the wire: the `RowDescription` message carries a `table_oid` and
`column_id` (attnum) per result column, exposed by `tokio_postgres::Column::table_oid()`
/ `column_id()` and currently discarded by `columns_from_row_meta`. That gives an
exact, non-heuristic answer — no SQL parsing required.

## What Changes

- **Backend — result provenance.** `columns_from_row_meta` stops discarding
  `table_oid` / `column_id`. A new `editability` resolver turns those into a
  discriminated `ResultEditability` payload: `editable` (schema, relation,
  PK columns, per-result-column base-column names, PK column indexes, enum labels)
  or `not_editable` with a machine-readable reason
  (`no_base_table`, `multiple_tables`, `not_a_table`, `no_primary_key`,
  `pk_not_selected`, `duplicate_projection`).
- **Backend — wire shape.** `RunSqlResult::Rows`, each `status: "ok"` outcome of
  `postgres_run_sql_many`, and the streaming `columns` event each gain an
  `editability` field. Additive only; every existing field is unchanged.
- **Frontend — editable ad-hoc grid.** `AdhocResultGrid` gains an optional `edit`
  prop. When supplied, its cells render through the existing `EditableCell`
  (same double-click → inline editor → commit path as the table viewer) and feed
  the existing `useEditBuffer`. When absent, behaviour is byte-for-byte the
  current read-only grid.
- **Frontend — non-editable cells explain themselves.** Double-clicking a cell that
  can't be edited does nothing *visible* but carries a `title` tooltip naming the
  reason ("Result mixes 2 tables", "Primary key not in the selected columns", …),
  matching how the table viewer already explains blocked cells.
- **Frontend — save path.** The result-panel header gains `Save (N)` / `Discard`
  controls (rendered only when the result is editable and the connection is
  writable). Save calls the existing `postgres_apply_table_edits` command — no new
  write path — then clears the buffer and re-runs the same statement so the user
  sees committed values.
- **Frontend — dirty guards.** A dirty result buffer blocks tab close, connection
  switch, and re-run behind the existing `DiscardChangesDialog`, and publishes a
  `useDirtySummary` entry, exactly as `TableViewerTab` does.
- Scope limit (deliberate, stated as spec text, not an accident): inline edit is
  offered only for **single-statement, non-streaming-in-flight rows results on a
  writable Postgres connection**. Multi-statement runs, in-flight streams,
  read-only connections, views, joins and computed columns stay read-only with a
  hover reason.

## Capabilities

### New Capabilities
- `sql-result-editability`: cross-cutting contract for deciding whether an ad-hoc
  SQL result set is safely writable — the `ResultEditability` payload shape, the
  provenance rules that produce it, and the reason taxonomy the UI renders. Owned
  here so MySQL/MSSQL can adopt the same contract later without redefining it.

### Modified Capabilities
- `postgres-sql-editor`: `postgres_run_sql`, `postgres_run_sql_many` and the
  `postgres_run_sql_stream` `columns` event carry `editability`; the result panel
  renders an editable grid plus Save/Discard and guards dirty state.
- `postgres-data-grid`: `AdhocResultGrid` is no longer unconditionally read-only —
  it accepts an optional edit configuration and renders `EditableCell`.
- `postgres-data-edit`: `postgres_apply_table_edits` is documented as the shared
  write path for both the table viewer and the SQL editor result grid, including
  the partial-projection case (the command already resolves column types itself).

## Impact

**Rust** (`packages/app/src-tauri/src/modules/postgres/`)
- `sql.rs` — `columns_from_row_meta`, `RunSqlResult::Rows`, `StreamEvent::Columns`,
  `run_one`, `run_one_stream`, `run_many`.
- new `editability.rs` — provenance resolver + catalog lookup + unit tests.
- `edit.rs` — extract the PK/enum catalog lookup so `editability.rs` reuses it.

**TypeScript** (`packages/app/src/modules/postgres/`)
- `sql/api.ts` — `RunSqlResult`, `StreamEvent` types.
- `sql/useQueryRun.ts` — thread `editability` through single + streaming state; add
  `rerunLast()`.
- `sql/ResultPanel.tsx` — real edit buffer, Save/Discard, re-run on commit.
- `sql/QueryTab.tsx` — Save/Discard header controls, dirty guards, discard dialog.
- `data/AdhocResultGrid.tsx` — optional `edit` prop, `EditableCell` rendering,
  buffer-aware copy/context-menu.
- `data/types.ts` — `ResultEditability` types.

**No changes to**: MySQL, MSSQL, Athena, CloudWatch, DynamoDB result grids; the
table viewer's edit flow; the `postgres_apply_table_edits` SQL builder; the
activity-log contract.

**Cost**: one extra catalog round-trip per rows-shaped run, skipped entirely when
no result column carries a `table_oid` (e.g. `SELECT 1`, pure aggregates).
