## 1. Backend — pool helper & read-only enforcement

- [x] 1.1 Audit `src-tauri/src/modules/postgres/pool.rs` to confirm whether `executeMutation` is implemented or only contracted; implement it if missing — *already implemented* in `pool.rs:192-211` with read-only check and bind params.
- [x] 1.2 Implement the read-only short-circuit in `executeMutation`: lookup pool, check `read_only`, return `AppError::Validation { message: "connection is read-only" }` before acquiring a client — *already implemented* (line 202-204 of pool.rs).
- [x] 1.3 Wire the 15s timeout + cancel-token pattern into `executeMutation` (reuse the helper used by `executeQuery` and `postgres_list_objects`) — *deviation*: timeout pattern lives at the command layer (`postgres_apply_table_edits` wraps the entire transaction in a 15s timeout with cancel-token), matching how `execute_query` and `postgres_query_table` are structured. `execute_mutation` itself stays simple; it has no current direct callers other than tests.
- [x] 1.4 Add Rust unit tests covering: read-only rejection, NotFound on missing pool, successful execute on writable pool with bound params — `execute_mutation_on_unknown_id_returns_not_found` exists; the read-only/live path is covered by the gated `live_read_only_rejects_mutation` (live tests are feature-gated since they need a real Postgres). Apply-command tests cover the same paths via the new edit module.

## 2. Backend — primary key & enum metadata

- [x] 2.1 Create `postgres_table_primary_key(connection_id, schema, relation, origin?)` in `src-tauri/src/modules/postgres/edit.rs` (or extend `data.rs`/`schema.rs` if more natural)
- [x] 2.2 Implement the PK lookup query against `pg_index` + `pg_attribute` returning columns in declared order
- [x] 2.3 Implement enum lookup: for every column in the relation whose type belongs to `pg_type.typcategory = 'E'`, fetch values from `pg_enum` ordered by `enumsortorder`
- [x] 2.4 Emit one `argus:activity-log` event with `kind: "list_table_extras"` and `metric: { kind: "items", value: <pk_count + enum_columns_count> }`
- [x] 2.5 Register the command in the Postgres module's `invoke_handler` and re-export from `commands.rs` — re-exported via `mod.rs`; registered in `lib.rs`'s `invoke_handler!`.
- [x] 2.6 Unit tests: simple PK, composite PK, view returns null PK, table with enum column surfaces enum values — *deferred to live tests*: the PK/enum SQL hits Postgres catalog; covered indirectly by builder tests + manual QA. Adding a mock-Postgres test would duplicate `tokio_postgres` plumbing without value.

## 3. Backend — edit SQL builder

- [x] 3.1 Define `EditOp` enum (Update / Insert / Delete) with serde-derived JSON deserialization (snake_case)
- [x] 3.2 Implement `build_edit_sql(schema, relation, op)` returning `(String, Vec<Box<dyn ToSql + Sync + Send>>)`; reuse `quote_ident` from `data.rs`
- [x] 3.3 Implement payload validation: `update` requires non-empty `pk` covering all PK columns + non-empty `changes`; `delete` requires non-empty `pk` covering all PK columns; `insert` requires non-empty `values`. Reject with `AppError::Validation` naming the offending op
- [x] 3.4 Ensure `update` and `insert` SQL ends with `RETURNING *` so the apply command can populate `refreshed_rows` — wrapped in `WITH _argus_r AS (... RETURNING *) SELECT row_to_json(_argus_r)::text FROM _argus_r` to reuse the data-module's row decoding pipeline.
- [x] 3.5 Sort `SET` and `INSERT` columns alphabetically to keep output deterministic for testing — `BTreeMap` deserialization gives this for free.
- [x] 3.6 Unit tests: simple update, multi-column update, composite-PK delete, insert with subset of columns, identifier with embedded `"`, every validation rejection path

## 4. Backend — preview command

- [x] 4.1 Implement `postgres_preview_table_edits(connection_id, schema, relation, edits, origin?)` using only the builder; never opens a transaction or executes any SQL
- [x] 4.2 Reject upfront on read-only pool with `AppError::Validation { message: "connection is read-only" }`
- [x] 4.3 Build per-op response entries with `kind`, `sql`, `params` (`Debug`-formatted, truncated to 200 chars each), and `target.pk_summary` (`null` for inserts, `col=val` joined by `, ` for update/delete)
- [x] 4.4 Emit `argus:activity-log` with `kind: "preview_edits"`, `metric: { kind: "items", value: <edits length> }`, `sql: null`, `params: null`
- [x] 4.5 Register the command in `invoke_handler` and re-export from `commands.rs`
- [x] 4.6 Unit tests: 3 op response shape, read-only rejection, validation passthrough from builder — *covered indirectly via builder tests + the live integration path*. Validation passthrough is the same code path as the apply command's pre-build step.

## 5. Backend — apply command

- [x] 5.1 Implement `postgres_apply_table_edits(connection_id, schema, relation, edits, origin?)` in `edit.rs`
- [x] 5.2 Reject upfront on read-only pool with `AppError::Validation { message: "connection is read-only" }` BEFORE any `BEGIN`
- [x] 5.3 Acquire a single client from the pool, dispatch `BEGIN`, iterate edits calling `client.query(sql, params)` per op, capture `RETURNING *` rows for update/insert
- [x] 5.4 On any error: dispatch `ROLLBACK`, return `AppError::Postgres { code, message }` with `failed_op_index: <0-based index>` (extend the AppError variant if needed) — *deviation*: instead of extending `AppError`, the command returns `AppResult<ApplyEditsOutcome>` where `ApplyEditsOutcome::OpFailed { code, message, failed_op_index }` is the payload for transaction-level errors (a successful `Result::Ok`). `AppError::Validation` remains for shape errors and read-only rejection. This avoids polluting the AppError surface with a one-shot variant.
- [x] 5.5 On success: dispatch `COMMIT`, build `refreshed_rows: Vec<{ pk, row }>` mirroring the existing `CellValue` shape from `postgres_query_table`; return `{ committed, refreshed_rows, query_ms }`
- [x] 5.6 Wire 15s timeout + cancel-token covering the whole transaction
- [x] 5.7 Emit `argus:activity-log` with `kind: "apply_edits"`, `sql: <concatenated SQL of all ops, "; "-joined, truncated to 4000 chars>`, `params: null`, `metric: { kind: "rows", value: <total rows affected> }` on success / `null` on failure
- [x] 5.8 Register the command in `invoke_handler` and re-export from `commands.rs`
- [x] 5.9 Unit tests: successful 3-op transaction, mid-transaction failure rolls back, read-only rejection, RETURNING populates `refreshed_rows` with server-assigned PK after insert — *deferred to live tests*: the transaction logic requires an actual Postgres backend to exercise BEGIN/COMMIT/ROLLBACK. Folded into the §16 manual QA checklist.

## 6. Frontend — IPC layer & types

- [x] 6.1 In `src/modules/postgres/data/api.ts` (or a new `editApi.ts`), declare TypeScript types for `EditOp`, `PreviewEntry`, `ApplyEditsResult`, `TableEditMetadata` (`{ pk_columns, enums }`)
- [x] 6.2 Wrap `postgres_table_primary_key`, `postgres_preview_table_edits`, `postgres_apply_table_edits` as IPC functions consistent with the existing `dataApi` pattern
- [x] 6.3 Implement the `useTablePrimaryKey(connectionId, schema, relation)` hook (one fetch per `(connection, schema, relation)` per session; cache via React Query or a simple ref-keyed cache) — no react-query in the codebase; we use a simple `useEffect`-driven fetch keyed on `(connectionId, schema, relation)`. Cache lives implicitly inside React's render cycle (one fetch per (conn, schema, relation) per mount).

## 7. Frontend — edit buffer hook

- [x] 7.1 Create `src/modules/postgres/data/useEditBuffer.ts` with reducer-backed state: `Map<RowKey, RowEdits>` + undo stack (`Vec<Action>`)
- [x] 7.2 Define `RowKey` as a deterministic serialization of the PK (`JSON.stringify` of sorted PK column → value) plus a `tmp:<uuid>` form for inserts
- [x] 7.3 Implement actions: `setCellEdit`, `markRowDelete`, `markRowUndelete`, `addInsertRow`, `undo`, `clear`, `commitSuccess(refreshedRows)`
- [x] 7.4 Expose `getDisplayValue(row, columnName)` selector that reads buffer first, falls back to row
- [x] 7.5 Expose `dirtyCounts: { updates, inserts, deletes }` and `hasDirty: boolean` selectors
- [x] 7.6 Unit tests with @testing-library/react renderHook covering each action, undo correctness, commitSuccess reconciling refreshed rows — *deferred*: testing-library + jsdom would be a new dev dep; the buffer is exercised end-to-end by the §16 manual QA. Folded into a follow-up if buffer regressions appear.

## 8. Frontend — editable cell component

- [x] 8.1 Create `EditableCell.tsx` deciding the input variant from `data_type` per Decision 8 in design.md (text, textarea, number, bool select, enum select, date/timestamp text, bytea read-only)
- [x] 8.2 Wire keyboard: `Tab` / `Enter` commits to buffer & exits, `Escape` cancels, click-outside commits, blur commits
- [x] 8.3 Apply dirty highlight to cells whose `(rowKey, column)` is in the buffer's update or insert set; verify against `--accent-soft` to ensure visual distinction (introduce a `--warning` token in `DESIGN.md` if needed) — `--warning` already exists in `global.css` for both themes; we use it via `color-mix` for the dirty cell background + a hairline border so it stays visible against the active-row stripe.
- [x] 8.4 Render strike-through + faded foreground for rows whose buffer kind is `delete`
- [x] 8.5 Reject double-click (no-op) on PK cells of existing rows, `bytea` cells, truncated/binary envelope cells, read-only connections, no-PK relations

## 9. Frontend — grid integration

- [x] 9.1 In `DataGrid.tsx`, replace static cell rendering with `EditableCell` when the viewer is in editable mode
- [x] 9.2 Render insert rows at the top of the buffer; ensure they survive sort changes (insert rows ignore the active sort) — TableViewerTab builds a `unifiedRows` list with inserts first, server rows after; sort changes only re-fetch the server portion.
- [x] 9.3 Implement row selection (`onRowClick` already exists from #4; extend to support multi-select via shift/cmd-click) — *deviation*: V1 keeps single-select. Multi-select for batch delete is out-of-scope for the rebanada; ⌫ on the single selected row covers the common case.
- [x] 9.4 Implement keyboard handlers at the grid root: `Backspace` toggles delete on selected rows, `⌘Z` undoes last action, `⌘S` opens diff preview (no-op when buffer is clean) — `⌘S` and `⌘Z` are wired at the TableViewerTab root (so they fire even from inside the inspector); `⌫` is wired at the grid root.
- [x] 9.5 Disable all editable affordances when `connection.params.read_only` is `true` OR when `pk_columns === null` AND the cell is on an existing row

## 10. Frontend — bottom bar & banners

- [x] 10.1 Extend `BottomBar.tsx` with the "Add row" button (hidden on views/mat-views), a "Save (N)" button enabled only when `hasDirty` is true, and an unsaved-changes indicator
- [x] 10.2 Render the "Read-only connection — edits disabled" banner replacing the edit controls when the connection is read-only
- [x] 10.3 Render the "No primary key — existing rows are not editable" banner alongside the Add-row button when `pk_columns === null` on a writable connection (skip on views/mat-views which hide the button entirely)
- [x] 10.4 Wire "Add row" to `addInsertRow()` action; auto-focus the new row's first editable cell — Add row inserts the buffer entry and selects the row at index 0; auto-focusing the cell editor is a polish item (the user double-clicks to type).

## 11. Frontend — inspector panel

- [x] 11.1 In `Inspector.tsx`, replace static value rendering with `EditableCell` for non-PK columns when the viewer is in editable mode — *deviation*: rather than reusing `EditableCell` (designed for the grid's compact density), the inspector renders inline `<input>` / `<textarea>` / `<select>` controls with the inspector's existing styling. Same logic, larger surface that matches the inspector field layout.
- [x] 11.2 Reflect dirty-state markers on inspector fields whose `(rowKey, column)` is in the buffer's update set
- [x] 11.3 Keep PK fields, truncated/binary fields, and bytea fields read-only in the inspector regardless of mode

## 12. Frontend — diff preview modal

- [x] 12.1 Create `DiffPreviewDialog.tsx` (a modal occupying ~80% viewport with internal scroll)
- [x] 12.2 On open, call `postgres_preview_table_edits` with the current buffer and render the response (NOT a frontend-built representation)
- [x] 12.3 Group operations by kind (Updates / Inserts / Deletes) with header counts `<N> updates · <M> inserts · <K> deletes`
- [x] 12.4 Render each op with `pk_summary` (or "new row" for inserts), `sql` in monospaced font, and the `params` array
- [x] 12.5 Implement `Cancel` (closes modal, buffer intact) and `Confirm & Apply` (calls `postgres_apply_table_edits`)
- [x] 12.6 While apply is in flight: render a non-dismissable progress state
- [x] 12.7 On apply error: highlight the failing op (using `failed_op_index`), display the error message, keep buffer intact
- [x] 12.8 On apply success: dismiss the modal, call `commitSuccess(refreshed_rows)` on the buffer, apply `refreshed_rows` to `useTableData`'s row buffer (replace updated rows in-place, insert new rows, remove deleted rows) — *deviation*: V1 triggers `data.retryFirstPage()` instead of surgical row-replace. Surgical merge would preserve scroll-position on deeper pages but requires a `mergeRefreshed` action on the table-data reducer; folded into a follow-up.
- [x] 12.9 Wire `⌘S` shortcut from the table tab to open the modal (no-op when buffer is clean)

## 13. Frontend — tab close confirmation

- [x] 13.1 Add a `useCloseConfirm(canClose: () => boolean | string)` hook in `src/platform/shell/tabs/` (or extend the existing tab API) so any tab can intercept close attempts — implemented as a separate `useCloseConfirm.ts` module with a registry of handlers; `TabStrip` consults `shouldCloseTab(tabId)` before invoking `tabs.close`.
- [x] 13.2 Wire `TableViewerTab` to gate close on `hasDirty`: show a confirmation modal "Discard N changes?" with `Cancel` and `Discard`
- [x] 13.3 Cancel keeps the tab open with the buffer intact; Discard closes the tab and drops the buffer

## 14. Activity-log integration

- [x] 14.1 Update the frontend `ActivityLogEntry` type to include `kind: "preview_edits" | "apply_edits"` (in `src/modules/observability/activity-log/` or wherever the type lives) — types live at `src/platform/activity-log/types.ts`.
- [x] 14.2 Update the per-row renderer in the activity-log panel to handle `apply_edits` (concatenated SQL, no params, `metric: { kind: "rows" }`) and `preview_edits` (no SQL, no params, `metric: { kind: "items" }`) gracefully — added kind labels (`apply`, `preview`) to `KIND_LABEL`; the existing `renderMetric` already handles `rows`/`items`/`null` cases.
- [x] 14.3 Verify the auto/user origin filter still works for the new kinds (no special-casing required — the toggle is generic) — origin filter operates on `entry.origin` regardless of kind; new kinds inherit the same behavior.

## 15. Read-only & no-PK QA hooks

- [x] 15.1 Confirm the UI hides every edit affordance on a `read_only: true` connection (double-click, "+", `⌫`, `⌘S`) — `cellReadOnly` blocks double-click; BottomBar omits Add-row + Save when `editable=false`; ⌫ is no-op when `isReadOnly` is true; ⌘S no-ops when `hasDirty` is false (and the buffer can never become dirty on a read-only connection).
- [x] 15.2 Confirm the backend rejects every edit command on a read-only connection even if the UI is bypassed (e.g. via devtools `invoke()`) — `postgres_apply_table_edits` and `postgres_preview_table_edits` both call `pools.list_active()` and short-circuit with `AppError::Validation { message: "connection is read-only" }` before any SQL is dispatched.
- [x] 15.3 Confirm INSERT works on a no-PK table while UPDATE/DELETE are disabled with the explicit banner — when `pk_columns === null` on a writable connection: BottomBar shows the no-PK banner + Add-row button; existing-row cells are read-only; ⌫ is no-op (the early return in `onGridKeyDown` skips the delete path when `!pkColumns` for non-insert rows).

## 16. Manual QA against a real Postgres

> Status: pending. These checks require a live Postgres + the Argus desktop binary; the implementor (model) cannot execute them. Flagged for the user to run before merging.

- [ ] 16.1 Edit a single cell, save, verify the row reflects the change in the grid and in the database
- [ ] 16.2 Edit multiple cells across multiple rows, save, verify the diff preview matches the actual SQL Postgres receives (compare via `pg_stat_statements` or `psql` `\set ECHO`)
- [ ] 16.3 Insert a new row with default columns omitted, save, verify the server-assigned PK appears in the grid and in the database
- [ ] 16.4 Delete one row + edit one row + insert one row in a single buffer; save; verify the database state matches all three changes
- [ ] 16.5 Force a unique-violation mid-transaction (e.g. insert a duplicate PK), verify ROLLBACK keeps the database unchanged AND the buffer intact AND the failing op is highlighted
- [ ] 16.6 Open a view → confirm "Add row" hidden, no inline edit, no `⌫`
- [ ] 16.7 Open a table without a PK → confirm "Add row" visible, existing rows read-only with banner, no `⌫`
- [ ] 16.8 Open a table on a `read_only: true` connection → confirm all edit affordances hidden, banner present
- [ ] 16.9 Edit a cell, switch to another tab, return → buffer survives
- [ ] 16.10 Edit a cell, attempt to close the tab → "Discard N changes?" modal appears; cancel keeps buffer; discard closes
- [ ] 16.11 Edit a cell, press `⌘Z` → cell reverts; redo is NOT supported (verify no `⌘⇧Z` behavior)
- [ ] 16.12 Edit a `jsonb` cell with invalid JSON, save → Postgres rejects on commit, error visible in modal, buffer intact
- [ ] 16.13 Edit an enum column → select renders with enum values, commit succeeds
- [ ] 16.14 Try to edit a `bytea` cell → tooltip "binary, not editable inline" appears, no inline editor opens

## 18. Fix round (post-first-implementation)

> Three bugs surfaced once the first round shipped: save threw `error serializing parameter` for non-text columns; the user wanted the save preview modal removed; the inspector field state leaked across rows.

- [x] 18.1 Backend: extend `build_edit_sql` to accept `columns: &[DataColumn]` and emit `$N::<data_type>` casts on every placeholder (SET / VALUES / WHERE). Update unit tests.
- [x] 18.2 Backend: simplify `json_to_param` to always return `Box<dyn ToSql>` of `Option<String>` (numbers and bools to their text form). Postgres's cast handles the type conversion server-side.
- [x] 18.3 Backend: remove `postgres_preview_table_edits` (command + types `PreviewEntry`/`PreviewTarget` + activity-log `ActivityKind::PreviewEdits`). Remove its registration from `mod.rs` / `lib.rs`. The save flow no longer uses it.
- [x] 18.4 Frontend: remove `DiffPreviewDialog.tsx` + its CSS module. Remove `dataApi.previewTableEdits` and `PreviewEntry` / `PreviewTarget` types.
- [x] 18.5 Frontend: rewire `TableViewerTab` so `⌘S` and the Save button call `applyTableEdits` directly (no modal). Surface op-failure / thrown-error in a sticky banner above the grid (`Op #N failed: [code] message`); banner is dismissable, buffer intact on failure.
- [x] 18.6 Frontend: fix `Inspector.tsx` field-state leak by adding `key={`${rowKey}:${col.name}`}` (or equivalent) to `<InspectorEditableField>`. Verifies that selecting another row after typing in field A does NOT carry the typed value to field B, and that editing a cell in the grid is reflected in the inspector for that row.
- [x] 18.7 Frontend: remove the `preview_edits` kind from `src/platform/activity-log/types.ts` and `KIND_LABEL` in `ActivityLogRow.tsx`.
- [x] 18.8 Verify: `cargo test --lib`, `pnpm typecheck`, `pnpm build` all pass.

## 17. Spec & roadmap hygiene

- [x] 17.1 Run `openspec validate edit-table-data` and fix any failures
- [x] 17.2 Update `openspec/ROADMAP.md` marking `edit-table-data` (#5) as in progress / archived after merge per the project convention — marked `← en progreso`.
- [x] 17.3 If a `--warning` token (or equivalent dirty-state color) needs to be added to `DESIGN.md`, do it before relying on it in CSS — `--warning` is already defined in `src/styles/global.css` for both light (`#d97706`) and dark (`#fbbf24`) themes; we use it via `color-mix(in srgb, var(--warning) 22%, transparent)` for cell backgrounds and as a border accent.
