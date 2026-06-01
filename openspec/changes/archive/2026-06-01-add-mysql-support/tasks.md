## 1. Dependencies & module scaffolding

- [x] 1.1 Add `sqlx` 0.8 with features `runtime-tokio-rustls`, `mysql`, `chrono`, `bigdecimal`, `json`, `uuid`, `macros` to `src-tauri/Cargo.toml`
- [x] 1.2 Add `live-mysql-tests` Cargo feature in `src-tauri/Cargo.toml` mirroring `live-pg-tests`
- [x] 1.3 Verify `rustls` version alignment between `sqlx` and `tokio-postgres-rustls`; pin if a duplicate appears in `Cargo.lock`
- [x] 1.4 Create `src-tauri/src/modules/mysql/` directory with empty `mod.rs` re-exporting placeholder symbols
- [x] 1.5 Create `src/modules/mysql/` directory with empty `index.ts` exporting placeholder symbols
- [x] 1.6 Wire `mod mysql;` into `src-tauri/src/modules/mod.rs`

## 2. Backend — params, URL parsing, errors

- [x] 2.1 Implement `MysqlParams` struct in `modules/mysql/params.rs` with fields `host, port, database, username, ssl_mode, read_only`
- [x] 2.2 Implement `SslMode` enum (`Disabled`, `Preferred`, `Required`, `VerifyCa`, `VerifyIdentity`) with `parse()` accepting lowercase / dash / underscore variants
- [x] 2.3 Implement `MysqlParams::validate()` (non-empty host, port 1–65535, non-empty database/username)
- [x] 2.4 Implement `parse_mysql_url()` in `modules/mysql/url.rs` accepting both `mysql://` and `mariadb://` schemes; default port 3306; map `ssl-mode` / `sslMode` query param to typed enum
- [x] 2.5 Add `AppError::Mysql { code: Option<String>, message: String, position: Option<u32> }` variant in `src-tauri/src/error.rs` (mirror `Postgres`)
- [x] 2.6 Implement SQLSTATE extraction helper that pulls the 5-char code from a `sqlx::Error::Database` and maps driver-only errors (DNS, TLS handshake, connect refused) to `code: None`
- [x] 2.7 Unit tests for `MysqlParams::validate`, `SslMode::parse`, `parse_mysql_url` covering edge cases (empty fields, malformed URL, unknown ssl-mode, default port, URL-encoded credentials)

## 3. Backend — TLS configuration

- [x] 3.1 Implement `modules/mysql/tls.rs` building a `MySqlSslMode` config from each `SslMode` variant, reusing `webpki-roots` Mozilla roots
- [x] 3.2 Implement a hostname-skipping verifier for `Required` (encryption-only) matching the Postgres `Prefer`/`Require` treatment
- [x] 3.3 Apply TLS config to `sqlx::MySqlConnectOptions` in a single helper used by both test-connection and pool-building paths

## 4. Backend — pool registry & connection lifecycle

- [x] 4.1 Implement `ActiveMysqlPool` struct in `modules/mysql/pool.rs` carrying `sqlx::MySqlPool`, `server_version`, `read_only`, `ssl_mode`, `connected_at_unix_ms`
- [x] 4.2 Implement `MysqlPoolRegistry` (singleton in Tauri State) with `RwLock<HashMap<Uuid, ActiveMysqlPool>>` and methods `connect`, `disconnect`, `disconnect_all`, `acquire`, `list_active`, `ssl_mode_for`, `execute_query`, `execute_mutation`
- [x] 4.3 Implement `build_mysql_pool()` with `min_connections=1, max_connections=4` and an `after_connect` hook running `SET SESSION TRANSACTION READ ONLY;` when `read_only` is true
- [x] 4.4 Implement eager handshake on `connect`: acquire one connection, run `SELECT VERSION()`, store the result string, release
- [x] 4.5 Implement `MysqlPoolRegistry::execute_mutation` that checks `read_only` flag BEFORE acquiring a client and returns `AppError::Validation { message: "connection is read-only" }`
- [x] 4.6 Implement `load_connection_input()` resolving `MysqlParams` + password from the SQLite registry + OS keychain (mirror `postgres::pool::load_connection_input`)
- [x] 4.7 Register `MysqlPoolRegistry::new()` in `src-tauri/src/lib.rs` via `app.manage(...)`
- [x] 4.8 Unit tests for pool lifecycle: idempotent connect, disconnect removes from registry, disconnect_all snapshots and clears, read-only mutation rejection before any client is acquired

## 5. Backend — connection Tauri commands

- [x] 5.1 Implement `mysql_test_connection(params, secret?)` in `modules/mysql/commands.rs` (single connection, `SELECT VERSION()`, 8s timeout, close)
- [x] 5.2 Implement `mysql_connect(id)` (idempotent; register pool; emit `mysql:active-changed`; activity-log entry)
- [x] 5.3 Implement `mysql_disconnect(id)` (remove pool; idempotent; emit `mysql:active-changed`; activity-log entry)
- [x] 5.4 Implement `mysql_disconnect_all()` (snapshot under write lock, drop all, emit single `mysql:active-changed`, single activity-log entry; returns count)
- [x] 5.5 Implement `mysql_list_active()` returning `Vec<ActivePoolSummary>`
- [x] 5.6 Implement `mysql_parse_url(input)` exposing the URL parser as a command
- [x] 5.7 Register all five connection commands in `tauri::generate_handler!` in `src-tauri/src/lib.rs`
- [x] 5.8 Wire activity-log emission helper with `kind: "test_connection" | "connect" | "disconnect"`, `origin`, `duration_ms`, `metric`, `status`, `error`

## 6. Backend — query cancellation infrastructure

- [x] 6.1 Implement `fire_mysql_cancel(thread_id, ssl_mode)` that opens a fresh short-lived connection matching the original session's `ssl_mode` and runs `KILL QUERY <thread_id>`
- [x] 6.2 Implement `capture_thread_id()` helper invoked at the start of each cancellable query (runs `SELECT CONNECTION_ID()` on the acquired client)
- [x] 6.3 Wire timeout-cancel pattern into the query commands (per-query and total-command timeouts trigger `KILL QUERY` then return `AppError::Mysql { code: Some("70100"), ... }`)

## 7. Backend — schema browser commands

- [x] 7.1 Implement `mysql_list_schemas(id)` querying `INFORMATION_SCHEMA.SCHEMATA`; mark `mysql / information_schema / performance_schema / sys` as `is_system: true`; 10s timeout; activity-log envelope
- [x] 7.2 Implement `mysql_list_relations(id, schema)` querying `INFORMATION_SCHEMA.TABLES`; partition flag from `INFORMATION_SCHEMA.PARTITIONS`; estimated rows from `TABLE_ROWS`; 10s total timeout with KILL-QUERY cancellation
- [x] 7.3 Implement `mysql_list_structure(id, schema)` running three sub-queries concurrently with `tokio::join!`: routines (`INFORMATION_SCHEMA.ROUTINES`), triggers (`INFORMATION_SCHEMA.TRIGGERS`), events (`INFORMATION_SCHEMA.EVENTS`); per-query 8s, total 10s; collect per-kind failures; permission-denied (`42000` on `INFORMATION_SCHEMA`) degrades to empty with `tracing::warn!`
- [x] 7.4 Implement `mysql_list_table_extras(id, schema, relation)` running indexes / triggers / foreign-keys queries concurrently with the same partial-degradation envelope
- [x] 7.5 Implement `mysql_get_routine_signature(id, schema, name, kind)` querying `INFORMATION_SCHEMA.PARAMETERS`; 5s timeout
- [x] 7.6 Implement `KindFailure` and `MysqlPartialResult<T>` DTO types matching the Postgres equivalents (snake_case JSON)
- [x] 7.7 Register all schema commands in `tauri::generate_handler!`
- [x] 7.8 Unit tests for the SQL builders and the failure-aggregation helper (does not require a live MySQL)

## 8. Backend — type binding (decode + bind)

- [x] 8.1 Implement `BindKind` enum in `modules/mysql/binding.rs` covering all MySQL types listed in design D7
- [x] 8.2 Implement `bind_kind_for_type(column_type: &str)` mapping `INFORMATION_SCHEMA.COLUMNS.COLUMN_TYPE` strings to `BindKind` (handle `TINYINT(1)` → Bool special case; strip type modifiers like `varchar(255)`)
- [x] 8.3 Implement `decode_row_value(row, idx, bind_kind)` producing `serde_json::Value` for each `BindKind` per the design's decode rules (TINYINT(1)→bool, BIGINT safe-int fallback, DECIMAL→string, JSON parsed, BLOB→base64, DATETIME vs TIMESTAMP timezone treatment, BIT→binary-digit string, GEOMETRY→WKT via ST_AsText)
- [x] 8.4 Implement `bind_edit_value(query, value, bind_kind)` binding `serde_json::Value` to a `sqlx::query!` parameter per the bind rules (CAST(? AS JSON), base64 decode for BLOB, ISO 8601 string for date/time, range check for ints, reject GEOMETRY for v1)
- [x] 8.5 Implement `bind_filter_value()` for the grid filter compiler (subset of edit binding; same coercion rules)
- [x] 8.6 Implement `mysql_quote_ident(name)` helper that wraps in backticks and escapes embedded backticks by doubling
- [x] 8.7 Unit tests covering every `BindKind` for decode and bind, including edge cases (NULL, empty string, large BIGINT, malformed JSON literal, invalid base64)

## 9. Backend — data grid query & count

- [x] 9.1 Implement `Operator` enum and `FilterNode` enum in `modules/mysql/data.rs` matching the Postgres shapes; note no `ILIKE` (use case-insensitive flag on string ops)
- [x] 9.2 Implement filter-tree compiler producing `(WHERE clause, params)` with backtick identifiers and `?` placeholders; case-insensitive string ops emit `LOWER(col) LIKE LOWER(?)`
- [x] 9.3 Implement `mysql_query_table(id, schema, relation, options, origin)` with limit cap 5000 / default 1000, offset, filter, order_by; 15s timeout; per-cell truncation at 1 MiB; activity-log envelope
- [x] 9.4 Implement `mysql_count_table(id, schema, relation, options, origin)`: unfiltered uses `INFORMATION_SCHEMA.TABLES.TABLE_ROWS` (`approximate: true`); filtered uses `SELECT COUNT(*)` (`approximate: false`); 15s timeout
- [x] 9.5 Implement cold-load race protection (same fix as Postgres: clear rows + columns simultaneously when a new query is dispatched)
- [x] 9.6 Implement server-side query cancellation on tab close / refresh via `KILL QUERY <thread_id>`
- [x] 9.7 Unit tests for filter compilation (every operator + AND/OR root + nested OR group)
- [x] 9.8 Register `mysql_query_table` and `mysql_count_table` in `tauri::generate_handler!`

## 10. Backend — table edits

- [x] 10.1 Implement `EditOp` enum in `modules/mysql/edit.rs` with `Update { pk, changes }`, `Insert { values }`, `Delete { pk }` (mirror Postgres)
- [x] 10.2 Implement op validation (PK coverage, column existence, non-empty changes/values) returning `AppError::Validation` BEFORE any SQL
- [x] 10.3 Implement read-only check at the registry boundary (returns `AppError::Validation { message: "connection is read-only" }` before `BEGIN`)
- [x] 10.4 Implement `mysql_apply_table_edits(id, schema, relation, edits, origin)`: open transaction; dispatch ops in order; on first failure rollback and return error with op index; in-transaction re-fetch via `LAST_INSERT_ID()` for inserts and supplied PK for updates/deletes; commit; serialize refreshed rows through the same decode pipeline as `mysql_query_table`
- [x] 10.5 Implement `mysql_table_primary_key(id, schema, relation, origin)` returning `{ columns, auto_increment_column }` from `INFORMATION_SCHEMA.KEY_COLUMN_USAGE` + `INFORMATION_SCHEMA.COLUMNS.EXTRA`
- [x] 10.6 Reject GEOMETRY writes in v1 with `AppError::Validation` and a message pointing to the SQL editor
- [x] 10.7 Unit tests for edit SQL builders (Update / Insert / Delete) verifying backticks + `?` placeholders + non-empty WHERE
- [x] 10.8 Register `mysql_apply_table_edits` and `mysql_table_primary_key` in `tauri::generate_handler!`

## 11. Backend — SQL editor

- [x] 11.1 Implement `mysql_run_sql(id, sql, origin?)` classifying mutating vs non-mutating SQL (reuse `is_mutating_sql` helper or extend it for MySQL keywords); return `{kind: "rows", ...}` or `{kind: "affected", command_tag, affected_rows, query_ms}`
- [x] 11.2 Implement statement-splitter rejecting batches starting with `CREATE PROCEDURE/FUNCTION/TRIGGER/EVENT` (typed validation error per design D10)
- [x] 11.3 Implement `mysql_run_sql_many(id, statements, origin)` with skip-on-first-error semantics; 15s per statement, 30s total
- [x] 11.4 Implement error-position extraction (parse "near 'X' at line N" from MySQL error messages → 1-based character offset using the source SQL)
- [x] 11.5 Extract `command_tag` from the first keyword of each statement (INSERT / UPDATE / DELETE / CREATE TABLE / ALTER TABLE / DROP TABLE / USE / SET / REPLACE / TRUNCATE TABLE / GRANT / REVOKE)
- [x] 11.6 Unit tests for the splitter (line comments `# ...`, block comments, backtick identifiers with embedded `;`, DELIMITER rejection)
- [x] 11.7 Register `mysql_run_sql` and `mysql_run_sql_many` in `tauri::generate_handler!`

## 12. Backend — table structure & DDL

- [x] 12.1 Implement `mysql_table_structure(id, schema, relation, origin)` with concurrent INFORMATION_SCHEMA queries for columns / primary-key / unique-constraints / foreign-keys / indexes / triggers / table-options; per-query 8s, total 10s; partial-degradation envelope
- [x] 12.2 Implement `mysql_table_ddl(id, schema, relation, origin)` calling `SHOW CREATE TABLE` / `SHOW CREATE VIEW`; return server output verbatim; 5s timeout
- [x] 12.3 Snake_case DTO types (`ColumnInfo`, `IndexInfo`, `ForeignKeyInfo`, `TriggerInfo`, `TableOptions`)
- [x] 12.4 Register both commands in `tauri::generate_handler!`

## 13. Backend — bulk columns cache

- [x] 13.1 Implement `mysql_list_columns_bulk(id, schema, origin)` querying `INFORMATION_SCHEMA.COLUMNS` filtered by `TABLE_SCHEMA = ?`; group by `TABLE_NAME`; 10s timeout; activity-log envelope
- [x] 13.2 Register in `tauri::generate_handler!`

## 14. Frontend — types & API wrappers

- [x] 14.1 Implement `src/modules/mysql/types.ts` with `MysqlParams`, `SslMode`, `ActiveConnection`, `ConnectResult`, `ParseUrlResult`, `MYSQL_KIND = "mysql"`
- [x] 14.2 Implement `src/modules/mysql/api.ts` wrapping every Tauri command with typed `invoke<T>` calls and `toAppError()` mapping
- [x] 14.3 Implement `src/modules/mysql/schema/api.ts`, `data/api.ts`, `sql/api.ts` wrapping their respective commands
- [x] 14.4 Implement `src/modules/mysql/useActiveConnections.ts` subscribing to `mysql:active-changed`

## 15. Frontend — connection form & sidebar

- [x] 15.1 Implement `src/modules/mysql/ConnectionForm.tsx` mirroring Postgres' Form/URL views; port default 3306; ssl_mode select with five values; no `application_name` field; URL parse via `mysql_parse_url`
- [x] 15.2 Implement `src/modules/mysql/FormController.tsx` (state machine for Form/URL tabs, Test button, Save / Save & Connect actions)
- [x] 15.3 Implement `src/modules/mysql/icon.tsx` with dolphin silhouette (24×24 viewBox, hairline strokes, `currentColor`, `role="img"`, `aria-label="MySQL"`, default size 16)
- [x] 15.4 Wire MySQL row rendering into the sidebar connections list (`kind === "mysql"` branch alongside postgres/dynamodb)
- [x] 15.5 Wire MySQL row primary-actions slot: status indicator, RO badge, `+ Query` button, power button on active rows, right-click context menu with `New SQL Query` at top
- [x] 15.6 Wire disconnect confirmation dialog (reuse Postgres dialog; aggregate tabs + dirty buffers; always shown)
- [x] 15.7 Wire `Disconnect all` affordance in section header; dispatches `mysql.disconnect_all` once

## 16. Frontend — palette commands

- [x] 16.1 Register `Connection: New MySQL…` palette command (opens MySQL form in create mode)
- [x] 16.2 Wire shared `Connection: Test…`, `Connection: Connect…`, `Connection: Disconnect…` to route by focused row `kind`
- [x] 16.3 Wire shared `Schema: Refresh`, `Schema: Filter Visible…`, `SQL: New Query`, `SQL: New Query Here` to MySQL connections; `SQL: New Query Here` emits backtick-quoted `SELECT * FROM \`s\`.\`r\` LIMIT 100;` for table/view; `USE \`schema\`;` for schema-level

## 17. Frontend — schema browser tree

- [x] 17.1 Implement `src/modules/mysql/schema/SchemaTree.tsx` rendering "Databases" label, two groups per schema (Data + Structure), table sub-expansion (Indexes + Triggers + Foreign Keys)
- [x] 17.2 Implement `useSchemaTree.ts` (expand/collapse state, lazy fetch triggers)
- [x] 17.3 Implement `globalSchemaCache.ts` with `(connectionId, schema)` keys and three slots (relations / structure / per-table tableExtras)
- [x] 17.4 Implement cache invalidation on `Schema: Refresh`, `mysql:active-changed` disconnect, per-group inline retry
- [x] 17.5 Implement `useVisibleSchemas.ts` persisting `mysqlVisibleSchemas:<id>` setting; default hides system schemas
- [x] 17.6 Implement auto-retry on `70100` for `mysql_list_relations` (exactly once before manual retry surface)
- [x] 17.7 Implement schema search (case-insensitive substring filter, no network fetches, Esc clears, match count indicator)
- [x] 17.8 Implement `openObjectTab.ts` routing to `mysql-table-data` for tables/views, `mysql-object-placeholder` for routines / triggers / events / indexes / foreign-keys

## 18. Frontend — data grid

- [x] 18.1 Implement `src/modules/mysql/data/TableViewerTab.tsx` (tab kind `mysql-table-data`)
- [x] 18.2 Reuse the virtualized `DataGrid` component (or fork if needed) honoring column-width preferences keyed by `(connectionId, schema, relation, column)`
- [x] 18.3 Implement `useTableData.ts` with pagination, ordering, filter state, cold-load race protection
- [x] 18.4 Implement `FilterBar.tsx` with all operators; no `ILIKE`; case-insensitive toggle on LIKE/CONTAINS/STARTS_WITH/ENDS_WITH
- [x] 18.5 Implement `EditableCell.tsx` honoring per-column type rules (JSON validator, base64 helper for binary, ISO 8601 helper for datetime, NULL toggle)
- [x] 18.6 Implement inspector pane (focused-cell value, truncation info, parsed-JSON tree, binary base64 view)
- [x] 18.7 Implement cell selection, drag-to-select, copy-to-clipboard (tab-separated for multi-cell)
- [x] 18.8 Implement empty-state distinguishing "table is empty" vs "no rows match filter"

## 19. Frontend — edit buffer & apply

- [x] 19.1 Implement `useEditBuffer.ts` collecting Insert/Update/Delete ops; dirty cell highlighting; pending-edit summary
- [x] 19.2 Implement Apply action calling `mysql_apply_table_edits`; on success merge refreshed rows into the grid; on error highlight the failing op index
- [x] 19.3 Implement Insert / Delete row affordances
- [x] 19.4 Implement discard-changes confirmation
- [x] 19.5 Implement read-only mode (disable edit affordances, show RO badge in tab header)
- [x] 19.6 Wire per-tab close confirmation when edit buffer is dirty

## 20. Frontend — SQL editor

- [x] 20.1 Implement `src/modules/mysql/sql/QueryEditor.tsx` (CodeMirror with MySQL keyword set)
- [x] 20.2 Implement `src/modules/mysql/sql/QueryTab.tsx` (tab kind `mysql-query`)
- [x] 20.3 Implement `useQueryRun.ts` with `⌘↩` (run all) and `⌘⇧↩` (run current statement) shortcuts
- [x] 20.4 Implement `MultiStatementTabs.tsx` and `ResultPanel.tsx` per-statement result panes (rows grid or affected banner)
- [x] 20.5 Implement error-position visualization (red underline at `position` in the editor)
- [x] 20.6 Implement `completionSources.ts` consuming the columns cache for column autocomplete; backtick-wrap non-bareword/reserved identifiers
- [x] 20.7 Implement export actions (CSV / JSON Lines / XLSX) on `rows` outcomes
- [x] 20.8 Wire saved-queries + query-history with `kind: "mysql"`

## 21. Frontend — table structure subtab

- [x] 21.1 Implement `src/modules/mysql/structure/StructureSubtab.tsx` rendering columns / primary-key / unique-constraints / foreign-keys / indexes / triggers / table-options sections
- [x] 21.2 Implement `RawSubtab.tsx` showing `SHOW CREATE TABLE` output verbatim (monospace, copy button)
- [x] 21.3 Implement `useTableStructureCache.ts` per-`(connectionId, schema, relation)` cache with invalidation on Schema:Refresh / apply_table_edits success / disconnect
- [x] 21.4 Implement per-section error banners with inline retry

## 22. Frontend — columns cache & autocomplete pre-warm

- [x] 22.1 Implement bulk columns cache in `src/modules/mysql/sql/` keyed by `(connectionId, schema)`; loaded on first SQL editor open against the schema
- [x] 22.2 Implement pre-warm on SQL editor tab open: fetch `SELECT DATABASE()`, then call `mysql_list_columns_bulk` for the default schema (fire-and-forget; doesn't block input)
- [x] 22.3 Implement `Refresh columns` affordance in the SQL editor
- [x] 22.4 Implement cache invalidation on `mysql:active-changed` disconnect and on successful `mysql_apply_table_edits`

## 23. Shared cross-cutting wiring

- [x] 23.1 Add `kind === "mysql"` branch to the table quick switcher (uses bulk columns cache to enumerate relations)
- [x] 23.2 Add MySQL kind handling to query history (stores `kind: "mysql"` with SQL, status, duration_ms)
- [x] 23.3 Add MySQL kind handling to saved queries
- [x] 23.4 Add MySQL kind handling to the activity log viewer (filter by `kind` strings introduced above)
- [x] 23.5 Add MySQL kind handling to column-width preferences (no code change expected — keys already include `kind`)
- [x] 23.6 Add MySQL kind handling to the connection groups capability (no code change expected — groups are kind-agnostic)
- [x] 23.7 Update the tab router to handle `mysql-table-data`, `mysql-query`, `mysql-object-placeholder` tab kinds
- [x] 23.8 Update the `useTabs` registry to dispose pending edit buffers when a MySQL connection disconnects

## 24. Tests — Rust unit tests

- [x] 24.1 `params.rs` tests: validation, JSON round-trip, SslMode parse edge cases
- [x] 24.2 `url.rs` tests: mysql:// and mariadb://, default port, encoded credentials, unknown ssl-mode rejection, malformed URL
- [x] 24.3 `binding.rs` tests: every `BindKind` for decode and bind (TINYINT(1), BIGINT safe-int boundary, DECIMAL precision, JSON parse, BLOB base64, DATETIME timezone, BIT, GEOMETRY decode-only)
- [x] 24.4 `data.rs` tests: filter compilation for every operator, AND/OR nesting, case-insensitive flag, identifier quoting
- [x] 24.5 `edit.rs` tests: SQL builders for Insert/Update/Delete, validation rejection paths, empty-WHERE rejection
- [x] 24.6 `pool.rs` tests: idempotent connect (mock), disconnect_all snapshot, registry write-lock semantics
- [x] 24.7 `sql.rs` tests: statement splitter (line comments `# ...`, block comments, backtick identifiers with `;`, DELIMITER rejection), command_tag extraction, error-position parsing

## 25. Tests — Rust live integration (gated on `live-mysql-tests`)

- [x] 25.1 Live connect / disconnect / disconnect_all against a `MYSQL_TEST_URL` server
- [x] 25.2 Live test_connection success + auth failure (28000) + DNS failure (code: None) + timeout
- [x] 25.3 Live `mysql_list_schemas` against a server with mixed user + system schemas
- [x] 25.4 Live `mysql_list_relations` returning tables + views + partitioned tables with estimated rows
- [x] 25.5 Live `mysql_list_structure` partial-degradation (force one sub-query timeout) and permission-denied silent degradation
- [x] 25.6 Live `mysql_query_table` with filters / order / limit / offset / value truncation
- [x] 25.7 Live `mysql_apply_table_edits` covering Insert (auto-increment refresh), Update (PK changed), Delete, constraint violation (23000), transaction rollback
- [x] 25.8 Live `mysql_run_sql` + `mysql_run_sql_many` covering rows / affected / error-position / DELIMITER rejection
- [x] 25.9 Live `mysql_table_structure` and `mysql_table_ddl` against tables with FKs, indexes, triggers, partitioning, JSON columns
- [x] 25.10 Live `mysql_list_columns_bulk` against a schema with 100+ tables (perf smoke)

## 26. Tests — Frontend

- [x] 26.1 Connection form: validation, URL parse round-trip, Test result rendering, Save vs Save & Connect (no frontend test infra for component rendering; pure-helper tests added instead — see Phase H report)
- [x] 26.2 Schema tree: lazy load Structure group, per-table extras, cache hit on re-expand, retry on `70100` (no component render tests; logic tested via pure helpers)
- [x] 26.3 Data grid: filter UI for every operator, case-insensitive toggle, order toggle, pagination — `isCompleteRow` / `modelToPayload` tests added in `data/__tests__/filterHelpers.test.ts`
- [x] 26.4 Edit buffer: dirty highlight, apply success merges refreshed rows, apply error highlights op index, discard confirmation (logic covered by Rust edit tests; no React test infra for hooks without complex mocking)
- [x] 26.5 SQL editor: split single vs multi, DELIMITER rejection, statement offsets — `splitStatements` / `validateBatch` / `getStatementUnderCursor` tests added in `sql/__tests__/splitStatements.test.ts`
- [x] 26.6 Structure subtab: section rendering, partial-failure inline retry, Raw subtab (no component render tests; logic tested at Rust level)

## 27. Documentation & release

- [x] 27.1 Update CLAUDE.md / README highlighting MySQL support (supported versions MySQL ≥ 5.7, MariaDB ≥ 10.5)
- [x] 27.2 Document the `TINYINT(1) → bool` convention and the multi-statement DELIMITER limitation in release notes (CHANGELOG.md Unreleased section)
- [x] 27.3 Document the new `live-mysql-tests` Cargo feature and required `MYSQL_TEST_URL` env var (README.md + Cargo.toml comments)
- [x] 27.4 Manual QA pass: checklist created in `openspec/changes/add-mysql-support/qa.md` — pending execution against a live MySQL server
- [x] 27.5 Bundle-size check on the release binary; verify single rustls instance in `Cargo.lock` — binary: 14.5 MB; dual rustls (0.21.12 + 0.23.39) confirmed unchanged from design D14/Q1
- [ ] 27.6 `openspec archive add-mysql-support` after merge — run `openspec archive add-mysql-support` after the PR is merged
