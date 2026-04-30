## 1. SQLite schema and migration

- [x] 1.1 Create `src-tauri/migrations/0002_query_history.sql` with the `query_history` table and the two indexes (`idx_query_history_started`, `idx_query_history_connection`) as specified in design.md §4
- [x] 1.2 Register the new migration in the `MIGRATIONS` constant in `src-tauri/src/platform/storage.rs`
- [x] 1.3 Verify on a fresh launch that `_migrations` records both `0001_init` and `0002_query_history` and that the table exists

## 2. Backend: query_history module

- [x] 2.1 Create `src-tauri/src/modules/query_history/mod.rs` with `HistoryEntry` struct mirroring the row schema (UUID id, BLOB connection_id, etc.) plus serde derives matching the JSON payload contract in the spec
- [x] 2.2 Implement `insert_entry(db, entry)` that takes the resolved fields from a single SQL run and writes one row, swallowing rusqlite errors after logging to `tracing::error!` (so persistence failures do NOT propagate per the postgres-sql-editor delta)
- [x] 2.3 Implement `list_entries(db, filters)` returning `(entries, total)` with WHERE clauses for connection_ids (IN), since/until, search (LIKE %?% case-insensitive via `LOWER`), status; ORDER BY `started_at DESC, id DESC`; LIMIT/OFFSET; clamp `limit` to 1..1000
- [x] 2.4 Implement `delete_one(db, id)` and `clear(db, filters)` — the latter shares the WHERE construction with `list_entries` and returns the affected row count
- [x] 2.5 Implement `prune_for_retention(db, retention_days, max_rows)` running the two DELETEs from design.md §6, in order, in a single transaction
- [x] 2.6 Add unit tests in `mod.rs` covering: insert + list round-trip, status filter, search filter (case-insensitive), pagination order with tie-breaker, retention by age, retention by cap, clear with and without filters

## 3. Backend: Tauri commands

- [x] 3.1 In a new `src-tauri/src/modules/query_history/commands.rs`, expose `query_history_list(filters) -> { entries, total }`, `query_history_delete(id) -> ()`, and `query_history_clear(filters) -> { deleted }` as `#[tauri::command]` with `Result<_, AppError>` returns
- [x] 3.2 Register the three commands in the Tauri builder (in `src-tauri/src/lib.rs` or wherever `postgres_run_sql` is registered)
- [x] 3.3 Confirm the commands appear in the generated TS bindings if any (otherwise no-op)

## 4. Backend: hook into postgres run-sql

- [x] 4.1 In `src-tauri/src/modules/postgres/sql.rs`, add a small helper `record_history_entry(app, connection_id, connection_name, sql, origin, started_at, duration_ms, outcome)` that builds a `HistoryEntry` and calls `query_history::insert_entry`
- [x] 4.2 In `postgres_run_sql`, call `record_history_entry` immediately after each `emit_activity()` site (success path, validation rejection, postgres error path) — passing the same fields used in the activity-log event
- [x] 4.3 In `postgres_run_sql_many`, do the same per-statement-step, AND verify that skipped statements never reach the helper
- [x] 4.4 Resolve `connection_name` from the `PgPoolRegistry` summary (or `connections_get_by_id`) — once per command invocation so multi-runs don't re-query — and pass it to the helper
- [x] 4.5 Add a test in `sql.rs` (using a real SQLite file in a temp dir) verifying that one ok + one err + one skipped multi-run produces exactly two `query_history` rows in the expected order with the expected fields

## 5. Backend: retention at startup and settings keys

- [x] 5.1 Read `queryHistory.retentionDays` and `queryHistory.retentionMaxRows` from the existing `settings` KV store at app startup (after migrations run); fall back to 30 and 10000 when keys are absent (do not write defaults)
- [x] 5.2 Call `query_history::prune_for_retention` once at startup with the resolved values, on a blocking task (rusqlite is sync)
- [x] 5.3 Test: seed the db with 100 old + 200 fresh entries plus 600 within-cap entries, launch with custom settings (`retentionDays=7`, `retentionMaxRows=500`), assert exactly 500 entries remain

## 6. Frontend: API layer

- [x] 6.1 Create `src/modules/query-history/api.ts` exposing `historyApi.list(filters)`, `historyApi.delete(id)`, `historyApi.clear(filters)` invoking the three Tauri commands; type `HistoryEntry` and `HistoryFilters` to match the Rust contract
- [x] 6.2 Define and export the `HistoryEntry` TS type with explicit nullable fields (`row_count?`, `command_tag?`, `error_code?`, `error_message?`)

## 7. Frontend: tab kind, sidebar entry, palette command

- [x] 7.1 Create `src/modules/query-history/HistoryTab.tsx` (component) and a tab kind constant `QUERY_HISTORY_KIND = "query-history"`; register the tab via `TabRegistry.register(QUERY_HISTORY_KIND, HistoryTabRoot)` on import
- [x] 7.2 Add an `openHistoryTab(tabs)` helper that calls `tabs.open({ id: "history", kind: QUERY_HISTORY_KIND, title: "History", payload: null, closable: true })` — single-instance via fixed id
- [x] 7.3 In `src/platform/shell/Sidebar.tsx`, add a new flat section labeled `Plataforma` below `Connections` with a single `History` row (clock icon) wired to `openHistoryTab(tabs)`; reuse the same row layout primitives used by Connections so the visual treatment matches
- [x] 7.4 In `src/modules/query-history/commands.ts`, register a palette command `{ id: "argus.history.open", label: "History: Open", group: "History", keywords: ["recent","queries","log"], run: () => openHistoryTab(tabs) }` and import it from the app bootstrap

## 8. Frontend: HistoryTab UI

- [x] 8.1 Build the filter bar: connection multi-select (sourced from the connections registry hook PLUS distinct connection ids present in fetched history but missing from registry, marked `(deleted)`); date-range with presets `Today / Last 7 days / Last 30 days / Custom`; search input with 200ms debounce; "Errors only" toggle; `Clear history` destructive button
- [x] 8.2 Build the virtualized list using `@tanstack/react-virtual` (already a dependency) with fixed row height ~44px; row renders `[hh:mm:ss · MMM dd] [conn-name pill] [SQL preview···] [12 ms · 5 rows] [✓/✗]`; full SQL on tooltip (and detail panel when row is selected)
- [x] 8.3 Wire fetch: when filters change OR the user scrolls near the bottom, refetch via `historyApi.list` with limit/offset; show `X of Y entries` from `total`
- [x] 8.4 Implement double-click / Enter / `Open in editor` button → call the SQL editor's `openQueryTab(tabs, { connectionId, connectionName, sql })`; disable when `connection_id` not in the active connections registry, with tooltip `Connection no longer registered`; keep `Copy SQL` always enabled
- [x] 8.5 Implement `Clear history` modal: read current count from the `total` of the active filter set, render `Delete N filtered history entries?` (or `Delete all N history entries?` if no filters), confirm → `historyApi.clear(activeFilters)` → refetch
- [x] 8.6 Empty state when total is 0 with active filters: copy `No matches for the current filters` and a `Reset filters` action

## 9. Verification

- [ ] 9.1 Manual: run a few SELECTs, INSERTs, and a multi-statement run with a deliberate error mid-way; open History tab and confirm all show up correctly with proper status badges
- [ ] 9.2 Manual: rename a connection, run a query, delete the connection, verify the History row keeps the old name and shows `(deleted)` in the picker; verify `Open in editor` is disabled but `Copy SQL` works
- [ ] 9.3 Manual: relaunch the app and verify history persists; tweak `queryHistory.retentionDays` to a small value, restart, verify pruning
- [ ] 9.4 Manual: open History via the sidebar entry, then via `History: Open` from the palette — both must focus the SAME tab (single-instance)
- [x] 9.5 Run `cargo test` and `npm test` (Vitest) to confirm new and existing suites pass — `cargo test --test-threads=1` → 116 passed (parallel run flakes pre-existing keychain test); `vite build` succeeds; `tsc --noEmit` clean for new code (only pre-existing error is `useTableData.test.tsx` from PR #12 — `@testing-library/dom` peer dep missing)
- [x] 9.6 Run `openspec validate query-history --strict` and confirm the change validates clean
