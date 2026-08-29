## 1. Backend — provenance capture

- [x] 1.1 In `packages/app/src-tauri/src/modules/postgres/sql.rs`, change `columns_from_row_meta` to return the per-column provenance alongside the `Vec<DataColumn>` — e.g. `fn columns_from_row_meta(&[tokio_postgres::Column]) -> (Vec<DataColumn>, Vec<ColumnProvenance>)` where `ColumnProvenance { table_oid: Option<u32>, attnum: Option<i16> }` reads `c.table_oid()` / `c.column_id()`. Do NOT add fields to `DataColumn`. Update the two call sites (`run_one` ~L753, `run_one_stream` ~L843).
- [x] 1.2 Add a unit test in `sql.rs` asserting the mapper preserves `None` provenance for computed columns (construct via the existing test helpers; if `tokio_postgres::Column` cannot be built in-process, cover the mapping through a pure helper `fn provenance_of(table_oid: Option<u32>, attnum: Option<i16>) -> ColumnProvenance` and test that instead).

## 2. Backend — editability resolver

- [x] 2.1 In `packages/app/src-tauri/src/modules/postgres/edit.rs`, extract the PK lookup and enum lookup bodies of `postgres_table_primary_key` into two `pub(crate)` async helpers (`lookup_pk_columns(&client, schema, relation)`, `lookup_enums(&client, schema, relation)`) reusing `SQL_PK_LOOKUP` / `SQL_ENUM_LOOKUP`, and rewrite the command to call them. Behaviour must be unchanged, including the "enum failure is non-fatal" rule.
- [x] 2.2 Create `packages/app/src-tauri/src/modules/postgres/editability.rs` and register it in `mod.rs`. Define `EditBlockReason` (serde snake_case: `NoBaseTable`, `MultipleTables`, `NotATable`, `NoPrimaryKey`, `PkNotSelected`, `DuplicateProjection`) and `ResultEditability` (`#[serde(tag = "status", rename_all = "snake_case")]`) with the `Editable { schema, relation, pk_columns, pk_column_indexes, column_sources, enums }` and `NotEditable { reason }` variants per `specs/sql-result-editability/spec.md`.
- [x] 2.3 Implement the pure decision function `pub fn decide(relation: Option<ResolvedRelation>, sources: &[Option<String>], pk_columns: Option<&[String]>, enums: BTreeMap<String, Vec<String>>) -> ResultEditability` covering, in order: no provenance → `no_base_table`; >1 distinct oid → `multiple_tables`; `relkind` not in `('r','p')` → `not_a_table`; duplicate non-null entry in `sources` → `duplicate_projection`; `pk_columns` none/empty → `no_primary_key`; any PK column absent from `sources` → `pk_not_selected`; otherwise `Editable` with `pk_column_indexes` built in `pk_columns` order.
- [x] 2.4 Unit-test `decide` for every branch in 2.3 plus the two positive cases from the spec (aliased projection, mixed computed column) and the "two computed columns are not duplicates" case. No database needed.
- [x] 2.5 Implement `pub async fn resolve(client, provenance: &[ColumnProvenance]) -> ResultEditability`: short-circuit to `NotEditable { NoBaseTable }` when every `table_oid` is `None` (no catalog query issued); otherwise issue one query resolving `(nspname, relname, relkind)` from `pg_class`/`pg_namespace` for the single oid plus `attname` for each projected attnum from `pg_attribute` (`attisdropped = false`), then call `lookup_pk_columns` / `lookup_enums`, then `decide`. Wrap the whole body so any `Err` or timeout returns `NotEditable { NoBaseTable }` and emits `tracing::warn!` — the run must never fail because of this.
- [x] 2.6 Confirm the short-circuit is exercised: add a test (or an assertion helper) proving `resolve` issues zero queries when all provenance is `None`.

## 3. Backend — wire the field through

- [x] 3.1 Add `editability: ResultEditability` to `RunSqlResult::Rows` and to `StreamEvent::Columns` in `sql.rs`. Leave `RunSqlResult::Affected` and the `Done` / `Affected` / `Error` stream events untouched.
- [x] 3.2 Call `editability::resolve` in `run_one` after `prepare` and before/while streaming rows, and in `run_one_stream` before emitting the `columns` event. `postgres_run_sql_many` inherits it via `run_one` — verify each `RunManyOutcome::Ok` carries its own value.
- [x] 3.3 Update the serialization test at `sql.rs:1719` (`run_sql_result_serializes_with_kind_tag`) and add one asserting an `affected` result serialises without an `editability` key.
- [x] 3.4 `cargo fmt` + `cargo clippy` clean; `pnpm rust:fmt:check` passes.

## 4. Frontend — types and runner plumbing

- [x] 4.1 In `packages/app/src/modules/postgres/data/types.ts`, add `EditBlockReason` and `ResultEditability` mirroring the Rust shapes, plus a type guard `isEditableResult(e: ResultEditability): e is Extract<ResultEditability, {status:"editable"}>`.
- [x] 4.2 In `packages/app/src/modules/postgres/sql/api.ts`, add `editability: ResultEditability` to the `kind: "rows"` variant of `RunSqlResult` and to the `event: "columns"` variant of `StreamEvent`.
- [x] 4.3 In `packages/app/src/modules/postgres/sql/useQueryRun.ts`, carry `editability` on `StreamingRunState` (captured from the `columns` event) and expose it on the terminal single-run state. Add `rerunLast(): Promise<void>` that re-executes the last single-statement run preserving its `sql` and `startOffset`; it must be a no-op when the last run was multi-statement or when no run has happened.
- [x] 4.4 Add a unit test for `rerunLast` (mock `sqlApi`) asserting the re-run dispatches the same SQL and that the resulting state keeps the original `startOffset`.

## 5. Frontend — editable AdhocResultGrid

- [x] 5.1 In `packages/app/src/modules/postgres/data/AdhocResultGrid.tsx`, add the optional `edit?: AdhocGridEdit` prop with the interface from `design.md` D7, and export the interface.
- [x] 5.2 Replace the inline data-cell `<div>` (currently ~L577-588) with `EditableCell`, passing `readOnly` computed per `specs/postgres-data-grid/spec.md`. In the no-`edit` case pass `readOnly: true`, `dirty: false`, `editing: false`, and a no-op `onStartEdit`, so DOM and behaviour are unchanged. Keep `data-col={ci}` on the rendered cell (it is what drag-select and the context menu read).
- [x] 5.3 Add local `editing: { rowIndex: number; col: string } | null` state and the `onStartEdit` / `onCancelEdit` / `onCommitEdit` handlers, mirroring `DataGrid.tsx:772-809` but with only the "existing server row" branch (no insert path). `onCommitEdit` must call `buffer.setCellEdit({ rowKey, column: baseColumnName, value, pk, originalRow: row, originalColumns: columnSources.map(s => s ?? "") })`.
- [x] 5.4 Compute each row's `rowKey` via `buildRowKey` from `edit.pkColumnIndexes` against that row's server values. Memoize per row index so re-renders don't rebuild it needlessly.
- [x] 5.5 Make cell `title` copy reflect the specific blocker: `edit.blockedReason` when non-empty, else `Primary key — not editable`, `Computed column — not editable`, `binary, not editable inline`, or `value too large to edit inline`. Extend `EditableCell`'s `title` logic (or pass an explicit `readOnlyReason` prop) so it can carry these — do not duplicate the cell component.
- [x] 5.6 Route ⌘C single-cell copy, the context menu's Copy cell, and Copy row(s) through a buffer-aware value resolver (reuse `resolveCellDisplayValue` from `DataGrid.tsx` — export it and adapt, or add a local equivalent) so pending edits are copied instead of server values.
- [x] 5.7 Enable the context menu's Edit cell entry: drop `copyOnly` when `edit` is supplied and editing is live, and wire `canEditCell` / `editCellDisabledReason` / `onEditCell` the way `DataGrid.tsx:598-662` does. Keep `canDeleteRows={false}` and `deleteDisabledReason=""` — insert/delete stay out.
- [x] 5.8 Verify the existing `AdhocResultGrid.copy.test.tsx`, `AdhocResultGrid.contextMenu.test.tsx` and `AdhocResultGrid.resize.test.tsx` still pass untouched. Fix the component, not the tests, if they break.
- [x] 5.9 Add `AdhocResultGrid.edit.test.tsx` covering: double-click opens an editor when `edit` is supplied; double-click is inert without `edit`; double-click is inert with a non-empty `blockedReason` and the cell carries it as `title`; PK / `null`-source / bytea / envelope cells are read-only; committing an edit on an aliased column emits `changes` keyed by the base column; the dirty highlight follows the PK row after the `rows` prop is reordered; copy returns the pending value.

## 6. Frontend — result panel edit mode

- [x] 6.1 In `packages/app/src/modules/postgres/sql/ResultPanel.tsx`, thread `editability`, the connection's `read_only` flag, and a `mode` discriminator (`single` vs `multi`) down to `RowsResultView`. Replace the `dummyBuffer` with a real `useEditBuffer()` used for both the grid and (still read-only) inspector.
- [x] 6.2 Compute `editEnabled = mode === "single" && !loading && isEditableResult(editability) && !isReadOnly`, and `blockedReason` from the precedence table in `specs/postgres-sql-editor/spec.md` (read-only connection first, then multi-statement, then streaming, then the wire `reason`). Pass the `edit` prop to `AdhocResultGrid` whenever a rows grid is rendered, so non-editable cells still get their hover reason.
- [x] 6.3 Clear the buffer whenever the result's column signature changes (extend the existing `columnsSig` effect at `ResultPanel.tsx:157`) so a new query can never carry stale edits.
- [x] 6.4 Add the op-failure / error banner above the grid, rendered from a `saveError` state and dismissable.
- [x] 6.5 Add `ResultPanel.edit.test.tsx`: editable result renders an editable grid; a `not_editable` result renders read-only cells with the reason as `title`; a read-only connection overrides an `editable` payload; a multi-statement outcome is never editable; a streaming-in-flight result is never editable.

## 7. Frontend — save, discard, and guards

- [x] 7.1 In `packages/app/src/modules/postgres/sql/QueryTab.tsx`, lift the result buffer's dirty state (or expose it from `ResultPanel` via a callback / context) so the result header can render `Discard` and `Save (<n>)` next to `ExportMenu` (`QueryTab.tsx:779-789`), using the existing `styles.toolbarButton` treatment. Render them only when the result is editable; `Save` disabled and unlabelled-count when clean. Do NOT bind ⌘S.
- [x] 7.2 Implement the save handler: build one `{ kind: "update", pk, changes }` op per dirty row from `buffer.toEditOps()`, call `dataApi.applyTableEdits(connectionId, schema, relation, edits, "user")` with `schema`/`relation` from the `editable` payload, then on `outcome === "ok"` call `buffer.commitSuccess()` + `runner.rerunLast()`, on `op_failed` set the banner to `Op #<i+1> failed: [<code>] <message>`, and on throw set the banner to the `AppError` message. Mirror `TableViewerTab.tsx:461-489`.
- [x] 7.3 Wire the loss guards: `useDirtySummary(tabId, dirty ? { connectionId, label: "<schema>.<relation> (result)" } : null)`; `useCloseConfirm(tabId, …)`; and gate `onRun` / `onRunAll` / `handleConnectionSelect` behind `DiscardChangesDialog` when the result buffer is dirty. The panel's own post-save re-run must bypass the guard.
- [x] 7.4 Confirm the existing query-level ⌘S save path and the existing query-dirty confirmation ("Dirty state tracking and unsaved-changes confirmation") are unaffected when only the result buffer is dirty, and that both dialogs can't stack.
- [x] 7.5 Add `QueryTab.resultEdit.test.tsx`: Save invokes `applyTableEdits` with the expected ops and clears the buffer on success; `op_failed` keeps the buffer and shows the banner; ⌘S with a dirty result buffer saves the query, not the rows; closing the tab with a dirty result buffer prompts; re-running with a dirty result buffer prompts.

## 8. Verification

- [x] 8.1 `pnpm typecheck` and `pnpm lint` clean.
- [x] 8.2 `pnpm test:run` green — in particular the pre-existing `AdhocResultGrid.*`, `ResultPanel`, `DataGrid.*` and `EditableCell` suites.
- [x] 8.3 `cargo test --manifest-path packages/app/src-tauri/Cargo.toml` green.
- [ ] 8.4 Manual pass against a real Postgres connection: `SELECT * FROM <keyed table> LIMIT 20` → double-click → edit → Save → values persist and the grid refreshes; `SELECT email FROM users` → hover shows the `pk_not_selected` copy; a join, a view, a `count(*)`, and a read-only connection each show their reason; `Run all` results are read-only.
- [x] 8.5 Review the new UI (Save/Discard controls, banner, hover copy) against `DESIGN.md` — fonts, accent usage, hairline borders, no decorative gradients — and against the tone rule that a blocked cell states the fact and, where one exists, the fix.
- [x] 8.6 Update `CHANGELOG.md` under the unreleased section referencing issue #279.
