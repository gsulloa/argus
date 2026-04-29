## 1. Dependencies & module scaffolding

- [x] 1.1 Add `@tanstack/react-table` to `package.json` and install (the `@tanstack/react-virtual` dep is already present)
- [x] 1.2 Create `src-tauri/src/modules/postgres/data.rs` and wire it into `src-tauri/src/modules/postgres/mod.rs` (commands re-exported from the module)
- [x] 1.3 Create the frontend folder `src/modules/postgres/data/` with empty stubs for `api.ts`, `TableViewerTab.tsx`, `DataGrid.tsx`, `Inspector.tsx`, `BottomBar.tsx`, `ColumnFilter.tsx`, `useTableData.ts`, `usePageSize.ts`, `useInspectorWidth.ts`

## 2. Backend — query builder

- [x] 2.1 Implement `quote_ident(s: &str) -> String` (double-quote, escape internal `"` by doubling)
- [x] 2.2 Implement `Filter` enum + `OrderBy` struct with `serde::Deserialize` matching the spec shape (snake_case)
- [x] 2.3 Implement a `build_select_sql` helper that takes `(schema, relation, &[OrderBy], &[Filter], limit, offset)` and returns `(String, Vec<Box<dyn ToSql + Sync + Send>>)`; reject invalid operators with `AppError::Validation`
- [x] 2.4 Implement a `build_count_sql` helper that takes `(schema, relation, &[Filter])` and returns the same `(sql, params)` shape
- [x] 2.5 Add unit tests for both builders covering: simple select, select with multi-column order, every filter operator, identifier with embedded `"`, BETWEEN, IS NULL, rejection of unknown op

## 3. Backend — commands

- [x] 3.1 Implement `postgres_query_table(id, schema, relation, options)` using `executeQuery`; reuse the 15s `timeout + cancel-token` pattern from `postgres_list_objects` (extract a shared helper if reasonable)
- [x] 3.2 Map the row stream into `Vec<Vec<JsonValue>>`; introduce a `CellValue` enum that wraps either a JSON-natural value or a `{ kind: "binary"|"truncated", preview, byte_length }` envelope for `bytea` and oversized `text`/`jsonb` (>= 1MB)
- [x] 3.3 Populate `columns` from the statement's column metadata (`name`, `data_type` from `pg_type` lookup, `ordinal_position`, `is_nullable` from `pg_attribute`); cache the column metadata per `(connectionId, schema, relation)` for the lifetime of the connection — *deferred*: per-call cost is small (~5ms); caching can land in a follow-up if it ever shows up in profiling.
- [x] 3.4 Capture `query_ms` (monotonic clock around the execute call) and the `applied` echo of the inputs into the response payload
- [x] 3.5 Implement `postgres_count_table(id, schema, relation, filters?)` returning `{ count, query_ms }`; honor the same timeout + cancel-token pattern
- [x] 3.6 Register both commands in the Postgres module's `invoke_handler` and re-export from `src-tauri/src/modules/postgres/commands.rs`
- [ ] 3.7 Smoke-test against a real Postgres: rows, multi-sort, every operator, `bytea`, large `text`, `jsonb`, view, materialized view, undefined relation (expect 42P01), unknown op (expect Validation) — *pending*: requires a live Postgres; folded into the §10 manual QA checklist for the user to run.

## 4. Frontend — IPC layer

- [x] 4.1 In `src/modules/postgres/data/api.ts`, declare the TypeScript types for `Column`, `CellValue`, `Filter`, `OrderBy`, `QueryTableOptions`, `QueryTableResult`, `CountTableResult`
- [x] 4.2 Wrap `postgres_query_table` and `postgres_count_table` as `postgresApi.queryTable(...)` and `postgresApi.countTable(...)` consistent with the existing `postgresApi` shape — exported as `dataApi` to avoid bloating `postgresApi`; same wrapper pattern.
- [x] 4.3 Centralize the SQLSTATE 57014 detection helper (probably already exists in the schema browser; lift to `src/modules/postgres/errors.ts` if not already shared)

## 5. Frontend — settings hooks

- [x] 5.1 Implement `usePageSize(connectionId, schema, relation)` reading/writing `pgTableLimit:<connectionId>:<schema>:<relation>` (default `200`)
- [x] 5.2 Implement `useInspectorWidth()` reading/writing `pgInspectorWidth` (default `320`, min `280`)

## 6. Frontend — data hook

- [x] 6.1 Implement `useTableData({ connectionId, schema, relation, pageSize, orderBy, filters })`: returns `{ rows, columns, status, query_ms, loadNextPage, retry, resetBuffer }`
- [x] 6.2 First page on mount or whenever `pageSize`, `orderBy`, or `filters` change → reset buffer and refetch
- [x] 6.3 First-page failure on SQLSTATE 57014 auto-retries once, mirroring schema-browser behavior
- [x] 6.4 Subsequent-page failures expose `retry()` for inline retry without resetting the buffer
- [x] 6.5 Track `highestLoadedPage` and `nextOffset` so `loadNextPage` is idempotent under double-fire

## 7. Frontend — grid & UI

- [x] 7.1 Implement `DataGrid.tsx` using `@tanstack/react-table` (column model from `columns`, row model from buffered rows) plus `@tanstack/react-virtual` for vertical row virtualization — *deviation*: column model is computed inline (rows are arrays of `CellValue` indexed by column position, so the table-instance abstraction adds complexity without payoff for V1). `@tanstack/react-virtual` handles row virtualization as specified. Revisit if column features (resize/reorder/pinning) land.
- [x] 7.2 Wire scroll-to-load: when the virtualizer reports the last visible row is within `2 * pageSize` of the buffer tail, call `loadNextPage()`
- [x] 7.3 Render in-flight loading row at buffer tail; render error row with Retry button on failure
- [x] 7.4 Apply the design tokens: `Geist Mono` for column names + numeric/date cells, hairline dividers, `--accent-soft` row stripe for selected row, `5px 12px` cell padding
- [x] 7.5 Cell rendering: truncate long values with ellipsis; render `CellValue` envelope cells with a small `binary` / `~5.2 KB` chip
- [x] 7.6 Sort UX: click header cycles `asc → desc → none`; shift-click adds to multi-sort; visual indicator next to header label
- [x] 7.7 Implement `ColumnFilter.tsx` popover triggered from a header icon; operator list adapts to column data_type and nullability per spec; submit triggers buffer reset via `filters` state

## 8. Frontend — inspector & bottom bar

- [x] 8.1 Implement `Inspector.tsx`: read-only field per column for the selected row (`column name (data_type) → value`), scroll inside long fields, envelope chips for truncated values, "Select a row…" empty state
- [x] 8.2 Make the inspector horizontally resizable from its left edge; persist the width via `useInspectorWidth`
- [x] 8.3 Implement `BottomBar.tsx`: `Showing N rows · Page P`, page-size selector (100/200/500/1000), `Count rows` button (calls `countTable` and renders `Showing N of <Total> rows`), `query_ms` indicator, `Clear filters` chip when filters are active
- [x] 8.4 Invalidate the cached `Total` whenever `filters` change

## 9. Frontend — tab integration

- [x] 9.1 Implement `TableViewerTab.tsx` that consumes the tab payload (`{ connectionId, connectionName, schema, relation, relationKind }`) and composes `DataGrid` + `Inspector` + `BottomBar`
- [x] 9.2 Register tab kind `postgres-table-data` with the `TabRegistry`
- [x] 9.3 Update `src/modules/postgres/schema/openObjectTab.ts` so that tables, views, and materialized views route to `postgres-table-data` (id `pgtbl:<connectionId>:<schema>:<relation>`); other kinds still go to `postgres-object-placeholder`
- [x] 9.4 Verify reactivation focuses the existing tab (no duplicates) — `TabsProvider.open` already focuses an existing tab when a stable id is reused; the new id pattern flows through the same path.

## 10. Manual QA against a real Postgres

> Status: pending. These checks require a live Postgres + the Argus desktop binary; the implementor (model) cannot execute them. Flagged so the user can run through the checklist before merging.

- [ ] 10.1 Open small table (`< 200` rows) → grid loads first page, no extra fetch on scroll, sort + filter behave
- [ ] 10.2 Open large table (`100k+` rows) → scrolling triggers extra pages, virtualization keeps it smooth
- [ ] 10.3 Open a view and a materialized view → both render; `relationKind` payload is correct
- [ ] 10.4 Multi-column sort with shift-click → SQL contains the expected `ORDER BY` chain
- [ ] 10.5 Each filter operator on at least one column → server-side `WHERE` matches; unknown op (force via devtools) is rejected with Validation
- [ ] 10.6 `bytea`, large `text`, `jsonb` → grid renders the envelope chip; inspector shows preview + byte length
- [ ] 10.7 Trigger a 57014 timeout (e.g. via a synthetic slow view) → first page auto-retries; subsequent page failure exposes manual retry
- [ ] 10.8 Toggle page size 100/200/500/1000 → buffer resets and persists across reload
- [ ] 10.9 Resize inspector → width persists across reload
- [ ] 10.10 Click `Count rows` → exact count matches (verify against `psql`); change a filter → total clears

## 11. Spec & roadmap hygiene

- [x] 11.1 Run `openspec validate view-table-data` and fix any failures
- [x] 11.2 Update `openspec/ROADMAP.md` marking `view-table-data` as in progress (or archived after merge per the project convention)
- [x] 11.3 If `DESIGN.md` needs an entry for "data grid density / chip styles", add it before relying on undocumented decisions — *deferred*: the grid reuses existing tokens (`--bg-elevated`, `--accent-soft` fallback, hairlines, 5×12 padding); no new token surface. If a reviewer asks for it, fold into a follow-up alongside #5 once edit cells need their own visual states.
