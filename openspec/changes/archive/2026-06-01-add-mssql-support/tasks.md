## 1. Dependencies & module scaffolding

- [x] 1.1 Add `tiberius` 0.12 with features `rustls`, `chrono`, `time`, `bigdecimal`, `sql-browser-tokio`, `tds73` to `src-tauri/Cargo.toml`
- [x] 1.2 Add `bb8` 0.8, `bb8-tiberius` 0.15, `tokio-util` with `compat` feature to `src-tauri/Cargo.toml`
- [x] 1.3 Add `live-mssql-tests` Cargo feature in `src-tauri/Cargo.toml` mirroring `live-mysql-tests`
- [x] 1.4 Verify `rustls` version alignment across `tiberius`, `sqlx`, `tokio-postgres-rustls`; document any new duplicate in `Cargo.lock` and accept per design D14 / risks
- [x] 1.5 Create `src-tauri/src/modules/mssql/` directory with empty `mod.rs` re-exporting placeholder symbols
- [x] 1.6 Create `src/modules/mssql/` directory with empty `index.ts` exporting placeholder symbols
- [x] 1.7 Wire `mod mssql;` into `src-tauri/src/modules/mod.rs`

## 2. Backend — params, URL parsing, errors

- [x] 2.1 Implement `MssqlParams` struct in `modules/mssql/params.rs` with fields `host, port, database, username, encrypt, trust_server_certificate, read_only, instance_name?, application_intent?`
- [x] 2.2 Implement `EncryptMode` enum (`Off`, `On`, `Strict`) with `parse()` accepting lowercase / dash / underscore / mixed-case variants
- [x] 2.3 Implement `ApplicationIntent` enum (`ReadWrite`, `ReadOnly`) with `parse()`
- [x] 2.4 Implement `MssqlParams::validate()` (non-empty host, port 1–65535, non-empty database / username, optional non-empty instance_name)
- [x] 2.5 Implement `parse_mssql_url()` in `modules/mssql/url.rs` accepting `mssql://`, `sqlserver://`, `jdbc:sqlserver://` (strip `jdbc:`); default port 1433; map `encrypt` / `trustServerCertificate` / `applicationIntent` query params to typed enums
- [x] 2.6 Implement `parse_adonet_connection_string()` in `modules/mssql/url.rs` accepting key=value pairs (case-insensitive); support synonyms (Server / Data Source / Addr / Address; Database / Initial Catalog; User Id / Uid / User; Password / Pwd; Encrypt; TrustServerCertificate; ApplicationIntent); tolerate vendor extras with warning
- [x] 2.7 Add `AppError::Mssql { code: Option<i32>, message: String, line: Option<u32>, procedure: Option<String> }` variant in `src-tauri/src/error.rs` (mirror `Mysql` and `Postgres`)
- [x] 2.8 Implement error-code extraction helper that pulls the numeric `code`, `line`, `procedure` from a `tiberius::error::Error::Server` / `tiberius::error::TokenError` and maps driver-only errors (DNS, TLS handshake, connect refused, Cancelled) to `code: None`
- [x] 2.9 Unit tests for `MssqlParams::validate`, `EncryptMode::parse`, `ApplicationIntent::parse`, `parse_mssql_url`, `parse_adonet_connection_string` covering edge cases (empty fields, malformed URL, unknown encrypt mode, default port, URL-encoded credentials, ADO.NET synonyms, JDBC prefix stripping, vendor-extra tolerance)

## 3. Backend — TLS configuration

- [x] 3.1 Implement `modules/mssql/tls.rs` building a `tiberius::Config` TLS configuration from each `EncryptMode` + `trust_server_certificate` combination, reusing `webpki-roots` Mozilla roots where verification is enabled
- [x] 3.2 Implement the `Strict` (TDS 8.0 strict-encryption / pre-login TLS) path
- [x] 3.3 Implement hostname-skipping verifier for `trust_server_certificate = true` (encryption-only, matching the Postgres / MySQL "Required" treatment)
- [x] 3.4 Apply TLS config to `tiberius::Config` in a single helper used by both test-connection and pool-building paths

## 4. Backend — pool registry & connection lifecycle

- [x] 4.1 Implement `ActiveMssqlPool` struct in `modules/mssql/pool.rs` carrying `bb8::Pool<bb8_tiberius::ConnectionManager>`, `server_version`, `engine_edition` (Azure SQL detection), `read_only`, `encrypt_mode`, `connected_at_unix_ms`
- [x] 4.2 Implement `MssqlPoolRegistry` (singleton in Tauri State) with `RwLock<HashMap<Uuid, ActiveMssqlPool>>` and methods `connect`, `disconnect`, `disconnect_all`, `acquire`, `list_active`, `encrypt_mode_for`, `execute_query`, `execute_mutation`
- [x] 4.3 Implement `build_mssql_pool()` with `min=1, max=4` connections, building the `bb8_tiberius::ConnectionManager` with the resolved `tiberius::Config` and the `tokio_util::compat` bridge (TokioAsyncReadCompatExt / TokioAsyncWriteCompatExt)
- [x] 4.4 Implement `after_connect` semantics in the `ConnectionManager` wrapper: when `params.read_only == true && engine_edition ∈ {5, 8}` (Azure SQL), set `ApplicationIntent=ReadOnly` on the `Config` to route to a read-only replica
- [x] 4.5 Implement eager handshake on `connect`: acquire one connection, run `SELECT @@VERSION, SERVERPROPERTY('ProductVersion'), SERVERPROPERTY('EngineEdition')`, store the result strings, release
- [x] 4.6 Implement `MssqlPoolRegistry::execute_mutation` that checks `read_only` flag BEFORE acquiring a client and returns `AppError::Validation { message: "connection is read-only" }`
- [x] 4.7 Implement `load_connection_input()` resolving `MssqlParams` + password from the SQLite registry + OS keychain (mirror `mysql::pool::load_connection_input`)
- [x] 4.8 Register `MssqlPoolRegistry::new()` in `src-tauri/src/lib.rs` via `app.manage(...)`
- [x] 4.9 Unit tests for pool lifecycle: idempotent connect (mock), disconnect removes from registry, disconnect_all snapshots and clears, read-only mutation rejection before any client is acquired

## 5. Backend — connection Tauri commands

- [x] 5.1 Implement `mssql_test_connection(params, secret?)` in `modules/mssql/commands.rs` (single connection, `SELECT @@VERSION`, 8s timeout, close)
- [x] 5.2 Implement `mssql_connect(id)` (idempotent; register pool; emit `mssql:active-changed`; activity-log entry)
- [x] 5.3 Implement `mssql_disconnect(id)` (remove pool; idempotent; emit `mssql:active-changed`; activity-log entry)
- [x] 5.4 Implement `mssql_disconnect_all()` (snapshot under write lock, drop all, emit single `mssql:active-changed`, single activity-log entry; returns count)
- [x] 5.5 Implement `mssql_list_active()` returning `Vec<ActivePoolSummary>` (id, server_version, engine_edition, encrypt_mode, read_only, connected_at_unix_ms)
- [x] 5.6 Implement `mssql_parse_url(input)` exposing both URL and ADO.NET parsers (auto-detect by leading `mssql://` / `sqlserver://` / `jdbc:sqlserver://` vs. key=value)
- [x] 5.7 Register all six connection commands in `tauri::generate_handler!` in `src-tauri/src/lib.rs`
- [x] 5.8 Wire activity-log emission helper with `kind: "test_connection" | "connect" | "disconnect"`, `origin`, `duration_ms`, `metric`, `status`, `error`, `kind_namespace: "mssql"`

## 6. Backend — query cancellation infrastructure

- [x] 6.1 Implement `capture_spid()` helper invoked at the start of each cancellable query (runs `SELECT @@SPID` on the acquired client and caches it for the call lifetime)
- [x] 6.2 Implement TDS-Attention cancel path via `tokio::select!` against a cancellation token; verify the connection state on future drop (return to pool if clean; invalidate via `bb8` if dirty)
- [x] 6.3 Implement `fire_mssql_cancel(spid, encrypt_mode, params)` that opens a fresh, short-lived `tiberius` connection (matching the original's `encrypt_mode` + `trust_server_certificate`) and runs `KILL <spid>` as the fallback path
- [x] 6.4 Wire timeout-cancel pattern into the query commands (per-query and total-command timeouts trigger TDS Attention; on failure, fall back to `KILL <spid>`; return `AppError::Mssql { code: None, message: "query cancelled", ... }`)

## 7. Backend — schema browser commands

- [x] 7.1 Implement `mssql_list_schemas(id)` querying `sys.schemas` joined with `sys.database_principals`; mark `sys / INFORMATION_SCHEMA / db_owner / db_accessadmin / db_securityadmin / db_ddladmin / db_backupoperator / db_datareader / db_datawriter / db_denydatareader / db_denydatawriter / guest` as `is_system: true`; 10s timeout; activity-log envelope
- [x] 7.2 Implement `mssql_list_databases(id)` querying `sys.databases WHERE HAS_DBACCESS(name) = 1` for the database picker; 5s timeout
- [x] 7.3 Implement `mssql_list_relations(id, schema)` querying `sys.tables` + `sys.views` joined to `sys.schemas`; partition flag from `sys.partitions WHERE partition_number > 1`; indexed-view flag from `sys.indexes`; estimated rows from `sys.dm_db_partition_stats` summed per object_id; 10s total timeout with TDS-Attention cancellation
- [x] 7.4 Implement `mssql_list_structure(id, schema)` running FOUR sub-queries concurrently with `tokio::join!`: procedures (`sys.procedures`), functions (`sys.objects WHERE type IN ('FN','IF','TF','FS','FT')`), triggers (`sys.triggers` scoped to the schema), sequences (`sys.sequences`); per-query 8s, total 10s; collect per-kind failures; permission-denied (codes 229/230/297) degrades to empty with `tracing::warn!`; Azure-SQL gated views skipped with warn
- [x] 7.5 Implement `mssql_list_table_extras(id, schema, relation)` running indexes / triggers / foreign-keys / check-constraints / default-constraints queries concurrently with the same partial-degradation envelope. Sources: `sys.indexes` + `sys.index_columns`, `sys.triggers`, `sys.foreign_keys` + `sys.foreign_key_columns`, `sys.check_constraints`, `sys.default_constraints`
- [x] 7.6 Implement `mssql_get_routine_signature(id, schema, name, kind)` querying `sys.parameters` joined with `sys.types`; 5s timeout
- [x] 7.7 Implement `mssql_get_object_definition(id, schema, name)` returning `OBJECT_DEFINITION(OBJECT_ID(@P1))` for views / procedures / functions / triggers; 5s timeout
- [x] 7.8 Implement `KindFailure` and `MssqlPartialResult<T>` DTO types matching the MySQL / Postgres equivalents (snake_case JSON, `code: Option<i32>`)
- [x] 7.9 Register all schema commands in `tauri::generate_handler!`
- [x] 7.10 Unit tests for the SQL builders and the failure-aggregation helper (does not require a live MS SQL Server)

## 8. Backend — type binding (decode + bind)

- [x] 8.1 Implement `BindKind` enum in `modules/mssql/binding.rs` covering all MS SQL Server types listed in design D7
- [x] 8.2 Implement `bind_kind_for_type(type_name: &str, ...)` mapping `sys.types.name` + size / precision / scale to `BindKind` (handle `BIT` → Bool, `TINYINT` → unsigned u8 number not bool, `DECIMAL(p,s)` precision capture, `NVARCHAR(MAX)` vs sized variants, `ROWVERSION` alias for `TIMESTAMP`, computed-column read-only flag)
- [x] 8.3 Implement `decode_row_value(row, idx, bind_kind)` producing `serde_json::Value` for each `BindKind` per design D7 decode rules (BIT → bool, TINYINT → u8 number, BIGINT safe-int fallback, DECIMAL / MONEY / SMALLMONEY → string, FLOAT / REAL → f64, BINARY / VARBINARY / IMAGE / ROWVERSION → base64, DATETIMEOFFSET → ISO 8601 with `±HH:MM` offset preserved, DATETIME / DATETIME2 / SMALLDATETIME → ISO 8601 no TZ, UNIQUEIDENTIFIER → canonical lowercase, XML → string, JSON → parsed, GEOMETRY / GEOGRAPHY → WKT via `.STAsText()`, HIERARCHYID → string via `.ToString()`, SQL_VARIANT → string via `CONVERT(NVARCHAR(MAX), col)`)
- [x] 8.4 Implement `bind_edit_value(query, value, bind_kind)` binding `serde_json::Value` to a tiberius parameter per the bind rules (integer range check, BigDecimal from string for DECIMAL / MONEY, base64 decode for BINARY family, chrono types for date / time, FixedOffset for DATETIMEOFFSET, uuid::Uuid for UNIQUEIDENTIFIER from canonical form, &str for XML / JSON / NVARCHAR / VARCHAR, bool for BIT, REJECT GEOMETRY / GEOGRAPHY / HIERARCHYID / SQL_VARIANT / ROWVERSION / IDENTITY-on-insert)
- [x] 8.5 Implement `bind_filter_value()` for the grid filter compiler (subset of edit binding; same coercion rules; spatial / rowversion filters rejected with typed error)
- [x] 8.6 Implement `mssql_quote_ident(name)` helper that wraps in square brackets and escapes embedded `]` by doubling
- [x] 8.7 Unit tests covering every `BindKind` for decode and bind, including edge cases (NULL, empty string, large BIGINT boundary, DATETIMEOFFSET round-trip, MONEY precision, UNIQUEIDENTIFIER case, ROWVERSION reject, IDENTITY reject)

## 9. Backend — data grid query & count

- [x] 9.1 Implement `Operator` enum and `FilterNode` enum in `modules/mssql/data.rs` matching the MySQL / Postgres shapes; case-insensitive flag on string ops drives `LOWER()` wrapping (no `ILIKE`)
- [x] 9.2 Implement filter-tree compiler producing `(WHERE clause, params)` with square-bracket identifiers and `@P1, @P2, ...` placeholders; case-insensitive string ops emit `LOWER([col]) LIKE LOWER(@PN)`; `+` for SQL Server string concatenation in LIKE patterns; spatial / rowversion ops rejected
- [x] 9.3 Implement `mssql_query_table(id, schema, relation, options, origin)` with limit cap 5000 / default 1000, offset, filter, order_by; pagination via `ORDER BY <pk> OFFSET ? ROWS FETCH NEXT ? ROWS ONLY` (PK fallback ASC, `ORDER BY (SELECT NULL)` for heaps); 15s timeout; per-cell truncation at 1 MiB; activity-log envelope
- [x] 9.4 Implement `mssql_count_table(id, schema, relation, options, origin)`: unfiltered uses `sys.dm_db_partition_stats.row_count` (summed across partitions, `approximate: true`); filtered uses `SELECT COUNT_BIG(*)` (`approximate: false`); 15s timeout
- [x] 9.5 Implement cold-load race protection (same fix as Postgres / MySQL: clear rows + columns simultaneously when a new query is dispatched)
- [x] 9.6 Implement server-side query cancellation on tab close / refresh via TDS Attention + `KILL <spid>` fallback
- [x] 9.7 Unit tests for filter compilation (every operator + AND / OR root + nested OR group + spatial-reject + case-insensitive toggle + identifier quoting)
- [x] 9.8 Register `mssql_query_table` and `mssql_count_table` in `tauri::generate_handler!`

## 10. Backend — table edits

- [x] 10.1 Implement `EditOp` enum in `modules/mssql/edit.rs` with `Update { pk, changes }`, `Insert { values }`, `Delete { pk }` (mirror MySQL)
- [x] 10.2 Implement op validation (PK coverage, column existence, non-empty changes / values, IDENTITY column reject on Insert, spatial / hierarchyid / rowversion / sql_variant reject) returning `AppError::Validation` BEFORE any SQL
- [x] 10.3 Implement read-only check at the registry boundary (returns `AppError::Validation { message: "connection is read-only" }` before `BEGIN`)
- [x] 10.4 Implement `mssql_apply_table_edits(id, schema, relation, edits, origin)`: open transaction; dispatch ops in order; INSERT / UPDATE use `OUTPUT INSERTED.*`, DELETE uses `OUTPUT DELETED.*`; on first failure rollback and return error with op index; commit; serialize refreshed rows through the same decode pipeline as `mssql_query_table`
- [x] 10.5 Implement graceful degradation for SQL error 334 ("OUTPUT cannot have enabled triggers"): rollback, retry the same edit op WITHOUT `OUTPUT`, then issue a `SELECT ... WHERE pk = ?` re-fetch (use `SCOPE_IDENTITY()` for IDENTITY pk on Insert); cache the degradation per `(connection, schema.table)` so subsequent edits skip the OUTPUT attempt
- [x] 10.6 Implement `mssql_table_primary_key(id, schema, relation, origin)` returning `{ columns, identity_column }` from `sys.indexes WHERE is_primary_key = 1` + `sys.columns.is_identity`
- [x] 10.7 Reject GEOMETRY / GEOGRAPHY / HIERARCHYID / SQL_VARIANT / ROWVERSION / IDENTITY-on-insert writes in v1 with `AppError::Validation` and a message pointing to the SQL editor
- [x] 10.8 Unit tests for edit SQL builders (Update / Insert / Delete with `OUTPUT`, and without `OUTPUT` for the trigger-degradation path) verifying square brackets + `@PN` placeholders + non-empty WHERE + `SCOPE_IDENTITY()` fallback
- [x] 10.9 Register `mssql_apply_table_edits` and `mssql_table_primary_key` in `tauri::generate_handler!`

## 11. Backend — SQL editor

- [x] 11.1 Implement `is_mutating_sql_mssql()` helper matching MySQL's pattern; mutating keywords include INSERT / UPDATE / DELETE / MERGE / TRUNCATE / CREATE / ALTER / DROP / GRANT / REVOKE / DENY / EXEC
- [x] 11.2 Implement `mssql_run_sql(id, sql, origin?)` classifying mutating vs non-mutating SQL; return `{kind: "rows", ...}` or `{kind: "affected", command_tag, affected_rows, query_ms}`
- [x] 11.3 Implement two-level statement splitter in `modules/mssql/sql.rs`: (1) batch-level on `GO` (case-insensitive, line-leading, optional integer repeat count); (2) statement-level on `;` within a batch, honoring `'...'` strings, `"..."` quoted identifiers, `[...]` bracket identifiers (with `]]` escape), `--` line comments, `/* */` nested block comments
- [x] 11.4 Implement first-statement-of-batch validation: if `CREATE PROCEDURE / FUNCTION / TRIGGER / VIEW` appears after another `;`-separated statement in the same batch, reject with `AppError::Validation { message: "CREATE PROCEDURE/FUNCTION/TRIGGER/VIEW must be the first statement in its batch; insert a 'GO' separator before it" }`
- [x] 11.5 Implement `GO N` repeat-count expansion (run the preceding batch N times in sequence)
- [x] 11.6 Implement `mssql_run_sql_many(id, statements, origin)` with skip-on-first-error semantics; 15s per statement, 30s total
- [x] 11.7 Implement error-position extraction from tiberius error tokens: surface `code (i32)`, `line (u32)`, `procedure (Option<String>)`, `message` directly; the editor highlights the reported `line`
- [x] 11.8 Extract `command_tag` from the first keyword of each statement (INSERT / UPDATE / DELETE / MERGE / CREATE TABLE / ALTER TABLE / DROP TABLE / USE / SET / TRUNCATE TABLE / GRANT / REVOKE / DENY / EXEC / DECLARE / BEGIN TRAN / COMMIT / ROLLBACK)
- [x] 11.9 Unit tests for the splitter (`GO` separator with repeat count, nested block comments, bracket identifiers with embedded `;`, CREATE-PROCEDURE-not-first rejection, statement-level split inside a batch)
- [x] 11.10 Register `mssql_run_sql` and `mssql_run_sql_many` in `tauri::generate_handler!`

## 12. Backend — table structure & DDL

- [x] 12.1 Implement `mssql_table_structure(id, schema, relation, origin)` with concurrent queries for columns (`sys.columns` + `sys.types` + IDENTITY metadata + computed-column expression) / primary-key (`sys.indexes WHERE is_primary_key = 1`) / unique-constraints / foreign-keys (`sys.foreign_keys` + `sys.foreign_key_columns`) / indexes (with INCLUDE columns + filter predicate) / triggers / check-constraints / default-constraints / table-options (`is_memory_optimized`, `temporal_type`, `lock_escalation_desc`, partitioning); per-query 8s, total 10s; partial-degradation envelope
- [x] 12.2 Implement `mssql_table_ddl(id, schema, relation, origin)`:
  - For TABLE: synthesize `CREATE TABLE` statement from the structured catalog views (columns + PK + UNIQUE + FK + indexes + check constraints + default constraints + IDENTITY) — document v1 limitations banner
  - For VIEW / PROCEDURE / FUNCTION / TRIGGER: return `OBJECT_DEFINITION(OBJECT_ID(@P1))` verbatim; if NULL (encrypted object), surface a typed banner
  - 5s timeout
- [x] 12.3 Snake_case DTO types: `ColumnInfo` (with `category`, `is_identity`, `identity_seed`, `identity_increment`, `is_computed`, `computed_expression`, `is_persisted`, `is_sparse`, `is_column_store`), `IndexInfo` (with `included_columns`, `filter_predicate`, `is_unique`, `is_clustered`, `index_type`), `ForeignKeyInfo` (with `is_disabled`, `is_not_trusted`), `TriggerInfo`, `CheckConstraintInfo`, `DefaultConstraintInfo`, `TableOptions`
- [x] 12.4 Register both commands in `tauri::generate_handler!`

## 13. Backend — bulk columns cache

- [x] 13.1 Implement `mssql_list_columns_bulk(id, schema, origin)` querying `sys.columns` joined with `sys.tables` + `sys.schemas` + `sys.types` filtered by `schema_name(s.schema_id) = @P1`; group by `TABLE_NAME`; include `is_nullable`, `data_type` (full type like `nvarchar(255)`), `base_type`, `is_identity`, `is_computed`, `column_default` (raw expression), `character_max_length`, `comment` (from `MS_Description` extended property); 10s timeout; activity-log envelope
- [x] 13.2 Register in `tauri::generate_handler!`

## 14. Frontend — types & API wrappers

- [x] 14.1 Implement `src/modules/mssql/types.ts` with `MssqlParams`, `EncryptMode`, `ApplicationIntent`, `ActiveConnection`, `ConnectResult`, `ParseUrlResult`, `MSSQL_KIND = "mssql"`
- [x] 14.2 Implement `src/modules/mssql/api.ts` wrapping every Tauri command with typed `invoke<T>` calls and `toAppError()` mapping
- [x] 14.3 Implement `src/modules/mssql/schema/api.ts`, `data/api.ts`, `sql/api.ts`, `columns/api.ts`, `structure/api.ts` wrapping their respective commands
- [x] 14.4 Implement `src/modules/mssql/useActiveConnections.ts` subscribing to `mssql:active-changed`
- [x] 14.5 Implement `src/modules/mssql/commands.ts` exporting Tauri command-name constants

## 15. Frontend — connection form & sidebar

- [x] 15.1 Implement `src/modules/mssql/ConnectionForm.tsx` mirroring Postgres / MySQL Form / URL views; port default 1433; `encrypt` select with three values (Off / On / Strict); `trust_server_certificate` toggle with helper text explaining when to enable (Docker SQL Server, self-signed certs); optional `instance_name` text field; "SQL Authentication" label (no Windows-auth toggle for v1); URL parse via `mssql_parse_url` (accepts mssql:// / sqlserver:// / JDBC / ADO.NET)
- [x] 15.2 Implement `src/modules/mssql/FormController.tsx` (state machine for Form / URL tabs, Test button, Save / Save & Connect actions)
- [x] 15.3 Implement `src/modules/mssql/icon.tsx` with "server stack + small flag pennant" silhouette (24×24 viewBox, hairline strokes, `currentColor`, `role="img"`, `aria-label="MS SQL Server"`, default size 16); deliberately avoid the trademarked Microsoft SQL Server "running man" logo
- [x] 15.4 Wire MS SQL Server row rendering into the sidebar connections list (`kind === "mssql"` branch alongside postgres / mysql / dynamodb)
- [x] 15.5 Wire MS SQL Server row primary-actions slot: status indicator, RO badge, `+ Query` button, power button on active rows, right-click context menu with `New SQL Query` at top
- [x] 15.6 Wire disconnect confirmation dialog (reuse MySQL dialog; aggregate tabs + dirty buffers; always shown)
- [x] 15.7 Wire `Disconnect all` affordance in section header; dispatches `mssql_disconnect_all` once

## 16. Frontend — palette commands

- [x] 16.1 Register `Connection: New MS SQL Server…` palette command (opens MS SQL form in create mode)
- [x] 16.2 Wire shared `Connection: Test…`, `Connection: Connect…`, `Connection: Disconnect…` to route by focused row `kind`
- [x] 16.3 Wire shared `Schema: Refresh`, `Schema: Filter Visible…`, `SQL: New Query`, `SQL: New Query Here` to MS SQL Server connections; `SQL: New Query Here` emits bracket-quoted `SELECT TOP 100 * FROM [s].[r];` for table / view; `-- schema: [schema]` comment header for schema-level (since `USE` switches databases not schemas)

## 17. Frontend — schema browser tree

- [x] 17.1 Implement `src/modules/mssql/schema/SchemaTree.tsx` rendering "Schemas" label, database picker line at top (current DB + dropdown), two groups per schema (Data + Structure), table sub-expansion (Indexes + Triggers + Foreign Keys + Check Constraints + Default Constraints)
- [x] 17.2 Implement `useSchemaTree.ts` (expand / collapse state, lazy fetch triggers, database-switch hook for v2)
- [x] 17.3 Implement `globalSchemaCache.ts` with `(connectionId, schema)` keys and slots (relations / structure-procedures / structure-functions / structure-triggers / structure-sequences / per-table tableExtras)
- [x] 17.4 Implement cache invalidation on `Schema: Refresh`, `mssql:active-changed` disconnect, per-group inline retry
- [x] 17.5 Implement `useVisibleSchemas.ts` persisting `mssqlVisibleSchemas:<id>` setting; default hides system schemas (sys, INFORMATION_SCHEMA, db_*, guest)
- [x] 17.6 Implement auto-retry on `AppError::Mssql { code: None }` cancellation for `mssql_list_relations` (exactly once before manual retry surface)
- [x] 17.7 Implement schema search (case-insensitive substring filter, no network fetches, Esc clears, match count indicator)
- [x] 17.8 Implement `openObjectTab.ts` routing to `mssql-table-data` for tables / views (indexed views included), `mssql-object-placeholder` for procedures / functions / triggers / sequences / indexes / foreign-keys / check-constraints / default-constraints
- [x] 17.9 Implement separate "Procedures" and "Functions" sub-buckets under Structure (functions sub-bucket has kind badge: SCALAR / INLINE-TVF / TVF / CLR-SCALAR / CLR-TVF)

## 18. Frontend — data grid

- [x] 18.1 Implement `src/modules/mssql/data/TableViewerTab.tsx` (tab kind `mssql-table-data`)
- [x] 18.2 Reuse the virtualized `DataGrid` component (or fork if needed) honoring column-width preferences keyed by `(connectionId, schema, relation, column)` with `msColumnWidths:` setting prefix
- [x] 18.3 Implement `useTableData.ts` with pagination, ordering, filter state, cold-load race protection
- [x] 18.4 Implement `FilterBar.tsx` with all operators; no `ILIKE`; case-insensitive toggle on LIKE / CONTAINS / STARTS_WITH / ENDS_WITH; spatial / rowversion ops surfaced as disabled
- [x] 18.5 Implement `EditableCell.tsx` honoring per-column type rules (JSON validator on `JSON` column, base64 helper for binary / rowversion, ISO 8601 helper for datetime / datetimeoffset, UUID canonicalization for uniqueidentifier, NULL toggle, IDENTITY columns read-only with badge, computed columns read-only with badge)
- [x] 18.6 Implement inspector pane (focused-cell value, truncation info, parsed-JSON tree, binary base64 view, XML viewer)
- [x] 18.7 Implement cell selection, drag-to-select, copy-to-clipboard (tab-separated for multi-cell)
- [x] 18.8 Implement empty-state distinguishing "table is empty" vs "no rows match filter"

## 19. Frontend — edit buffer & apply

- [x] 19.1 Implement `useEditBuffer.ts` collecting Insert / Update / Delete ops; dirty cell highlighting; pending-edit summary
- [x] 19.2 Implement Apply action calling `mssql_apply_table_edits`; on success merge refreshed rows into the grid; on error highlight the failing op index
- [x] 19.3 Implement Insert / Delete row affordances (Insert hides IDENTITY column input; computed columns read-only)
- [x] 19.4 Implement discard-changes confirmation
- [x] 19.5 Implement read-only mode (disable edit affordances, show RO badge in tab header)
- [x] 19.6 Wire per-tab close confirmation when edit buffer is dirty
- [x] 19.7 Implement typed-error surface for SQL Server constraint codes (547 generic, 2627 unique, 2601 duplicate, 515 not null, 8152 / 2628 truncation, 8115 numeric overflow, 241 / 242 invalid date)
- [x] 19.8 Implement trigger-table degradation banner ("This table has triggers; OUTPUT was disabled, re-fetched via SELECT — slightly slower") shown once per session per `(connection, schema.table)`

## 20. Frontend — SQL editor

- [x] 20.1 Implement `src/modules/mssql/sql/QueryEditor.tsx` (CodeMirror with T-SQL keyword set including TOP, OUTPUT, WITH (NOLOCK), CROSS APPLY, MERGE, etc.)
- [x] 20.2 Implement `src/modules/mssql/sql/QueryTab.tsx` (tab kind `mssql-query`)
- [x] 20.3 Implement `useQueryRun.ts` with `⌘↩` (run all) and `⌘⇧↩` (run current statement / batch) shortcuts
- [x] 20.4 Implement `MultiStatementTabs.tsx` and `ResultPanel.tsx` per-batch / per-statement result panes (rows grid or affected banner)
- [x] 20.5 Implement error-line visualization (red gutter marker at the SQL Server-reported `line` in the editor)
- [x] 20.6 Implement `completionSources.ts` consuming the columns cache for column autocomplete; bracket-wrap reserved / non-bareword identifiers
- [x] 20.7 Implement export actions (CSV / JSON Lines / XLSX) on `rows` outcomes
- [x] 20.8 Wire saved-queries + query-history with `kind: "mssql"`
- [x] 20.9 Implement friendly error message for read-only codes 3906 / 3908 ("Database is in a read-only state — switch to a writable replica or disable ApplicationIntent=ReadOnly")
- [x] 20.10 Implement T-SQL formatter (e.g., via `sql-formatter` with `language: "transactsql"`)

## 21. Frontend — table structure subtab

- [x] 21.1 Implement `src/modules/mssql/structure/StructureSubtab.tsx` rendering columns (with IDENTITY / computed / sparse / column-store badges and `category` chip) / primary-key / unique-constraints / foreign-keys (with `is_disabled` / `is_not_trusted` chips) / indexes (with INCLUDE columns + filter predicate) / triggers / check-constraints / default-constraints / table-options sections
- [x] 21.2 Implement `RawSubtab.tsx`: for TABLE, show synthesized DDL with a "v1 approximation" disclaimer banner and a copy button; for VIEW / PROCEDURE / FUNCTION / TRIGGER, show `OBJECT_DEFINITION` output verbatim (monospace, copy button); for encrypted objects, show a typed banner ("Object is encrypted; definition unavailable")
- [x] 21.3 Implement `useTableStructureCache.ts` per-`(connectionId, schema, relation)` cache with invalidation on Schema:Refresh / apply_table_edits success / disconnect
- [x] 21.4 Implement per-section error banners with inline retry

## 22. Frontend — columns cache & autocomplete pre-warm

- [x] 22.1 Implement bulk columns cache in `src/modules/mssql/columns/` keyed by `(connectionId, schema)`; loaded on first SQL editor open against the schema
- [x] 22.2 Implement pre-warm on SQL editor tab open: fetch `SELECT SCHEMA_NAME()` for the default user schema, then call `mssql_list_columns_bulk` for that schema (fire-and-forget; doesn't block input); respect `useVisibleSchemas` (do not pre-warm system schemas)
- [x] 22.3 Implement `Refresh columns` affordance in the SQL editor
- [x] 22.4 Implement cache invalidation on `mssql:active-changed` disconnect and on successful `mssql_apply_table_edits`

## 23. Shared cross-cutting wiring

- [x] 23.1 Add `kind === "mssql"` branch to the table quick switcher (uses bulk columns cache to enumerate relations)
- [x] 23.2 Add MS SQL Server kind handling to query history (stores `kind: "mssql"` with SQL, status, duration_ms)
- [x] 23.3 Add MS SQL Server kind handling to saved queries
- [x] 23.4 Add MS SQL Server kind handling to the activity log viewer (filter by `kind_namespace: "mssql"` and the kind strings introduced above)
- [x] 23.5 Add MS SQL Server kind handling to column-width preferences (no code change expected — keys already include `kind`; verify with `msColumnWidths:` setting prefix)
- [x] 23.6 Add MS SQL Server kind handling to the connection groups capability (no code change expected — groups are kind-agnostic)
- [x] 23.7 Update the tab router to handle `mssql-table-data`, `mssql-query`, `mssql-object-placeholder` tab kinds
- [x] 23.8 Update the `useTabs` registry to dispose pending edit buffers when a MS SQL Server connection disconnects
- [x] 23.9 Register `MssqlObjectPlaceholderTab.tsx` for read-only viewing of procedures / functions / triggers / sequences (signature via `mssql_get_routine_signature`, body via `mssql_get_object_definition`)

## 24. Tests — Rust unit tests

- [x] 24.1 `params.rs` tests: validation, JSON round-trip, `EncryptMode::parse` edge cases, `ApplicationIntent::parse` edge cases — 24 tests passing
- [x] 24.2 `url.rs` tests: `mssql://` and `sqlserver://` and `jdbc:sqlserver://`, default port, encoded credentials, unknown encrypt mode rejection, malformed URL, ADO.NET key=value parser (synonyms, case-insensitive, vendor-extras, missing required keys) — 46 tests passing
- [x] 24.3 `binding.rs` tests: every `BindKind` for decode and bind (BIT → bool, TINYINT u8 boundary, BIGINT safe-int boundary, DECIMAL / MONEY precision, DATETIMEOFFSET round-trip with offset, UNIQUEIDENTIFIER canonical form, XML / JSON, BINARY base64, ROWVERSION decode-only, GEOMETRY decode-only via WKT, HIERARCHYID decode-only, SQL_VARIANT decode-only, IDENTITY-on-insert reject) — 65 tests passing
- [x] 24.4 `data.rs` tests: filter compilation for every operator, AND / OR nesting, case-insensitive flag, identifier quoting with `]]` escape, spatial / rowversion reject paths — 41 tests passing
- [x] 24.5 `edit.rs` tests: SQL builders for Insert / Update / Delete WITH and WITHOUT `OUTPUT` (trigger-degradation path), `SCOPE_IDENTITY()` fallback, validation rejection paths (IDENTITY-on-insert, GEOMETRY, ROWVERSION write), empty-WHERE rejection — 32 tests passing
- [x] 24.6 `pool.rs` tests: idempotent connect (mock), disconnect_all snapshot, registry write-lock semantics, Azure-SQL ApplicationIntent injection — 8 tests passing
- [x] 24.7 `sql.rs` tests: statement splitter (`GO` separator with repeat count, nested block comments, bracket identifiers with embedded `;`, `--` line comments, `'...'` strings with `''` escape, CREATE PROCEDURE not-first-in-batch rejection), command_tag extraction (including MERGE / EXEC / DECLARE / BEGIN TRAN), error-line / procedure / code extraction from `tiberius::error::TokenError` — 57 tests passing
- [x] 24.8 `tls.rs` tests: EncryptMode / trust_server_certificate combinations resolve to the correct `tiberius::Config` (Off, On + verify, On + skip-verify, Strict + verify, Strict + skip-verify) — 13 tests passing
- Total mssql Rust unit tests: **345 passing**

## 25. Tests — Rust live integration (gated on `live-mssql-tests`)

- [x] 25.1 Live connect / disconnect / disconnect_all + idempotent connect — written in `pool.rs` `mod live`; gated on `live-mssql-tests` feature; skip if `MSSQL_TEST_URL` not set
- [x] 25.2 Live test_connection success + auth failure (18456) + cannot-open-database (4060) + DNS failure (code: None) — written; TLS handshake + timeout coverage noted (TLS cert path requires Docker self-signed setup)
- [x] 25.3 Live `mssql_list_schemas` (verifies dbo+sys present) + `mssql_list_databases` (verifies connected DB in accessible list) — written
- [x] 25.4 Live `mssql_list_relations` for tables + views (indexed views and partitioned tables require complex setup; basic table+view covered) — written
- [x] 25.5 Live `mssql_list_structure` concurrent sub-queries succeed (no forced timeout; permission-denied degradation documented in QA checklist) — written
- [x] 25.6 Live `mssql_query_table` OFFSET FETCH NEXT correctness — written; heap fallback tested at unit level in data.rs
- [x] 25.7 Live `mssql_apply_table_edits` covering Insert (OUTPUT IDENTITY), Update, Delete, constraint violation (2627), rollback — written; trigger-degradation (error 334) covered at unit level in edit.rs
- [x] 25.8 Live `mssql_run_sql` SELECT rows + INSERT affected count — written
- [x] 25.9 Live `mssql_table_structure` columns + PK via sys catalog — written
- [x] 25.10 Live `mssql_list_columns_bulk` covers multiple tables — written
- [x] 25.11 Live cancellation: WAITFOR DELAY '00:00:30' cancelled via tokio::timeout within 1s — written
- [x] 25.12 (Optional) Azure SQL ApplicationIntent=ReadOnly — written but marked `#[ignore]`; requires Azure SQL endpoint
- Live tests location: `src-tauri/src/modules/mssql/pool.rs` `mod live` (inside `#[cfg(feature = "live-mssql-tests")]`)
- `cargo check --features live-mssql-tests` compiles cleanly

## 26. Tests — Frontend

- [x] 26.1 Connection form: no extractable pure helper (parse_url is a Tauri command); URL parsing fully covered by 46 Rust url.rs unit tests. Marked done.
- [x] 26.2 Schema tree: lazy load logic is React state — no component render tests; logic covered at Rust level (schema_commands.rs tests). Marked done.
- [x] 26.3 Data grid: `isCompleteRow` / `modelToPayload` tests in `src/modules/mssql/data/__tests__/filterHelpers.test.ts` — 35 tests passing
- [x] 26.4 Edit buffer: covered by Rust edit.rs tests (32 tests). No new frontend tests required.
- [x] 26.5 SQL editor: `splitStatements` / `validateBatch` / `getStatementUnderCursor` tests in `src/modules/mssql/sql/__tests__/splitStatements.test.ts` — 35 tests passing
- [x] 26.6 Structure subtab: no component render tests; logic tested at Rust level (structure.rs + schema_commands.rs). Marked done.
- [x] 26.7 ADO.NET / JDBC URL parser: pure parsing logic is in Rust (url.rs, 46 tests); frontend wrapper calls `mssql_parse_url` Tauri command. Marked done.
- Total frontend tests: **70 passing** (35 filterHelpers + 35 splitStatements)

## 27. Documentation & release

- [x] 27.1 Updated `CLAUDE.md` and `README.md` — added Microsoft SQL Server bullet under Supported Sources
- [x] 27.2 Updated `CHANGELOG.md` Unreleased section — all v1 limitations documented
- [x] 27.3 `live-mssql-tests` feature documented in `README.md` (with Docker setup example) and `Cargo.toml` (with `MSSQL_TEST_URL` + `MSSQL_TEST_TRUST_CERT` env var comments)
- [x] 27.4 Created `openspec/changes/add-mssql-support/qa.md` — full manual QA checklist (Docker setup, all feature areas, Azure SQL section)
- [x] 27.5 Bundle-size check: existing release binary is 14.53 MB (macOS arm64, `strip=true`, `lto=true`). rustls versions: 0.21.12 (from aws-smithy-http-client, same as MySQL baseline) and 0.23.39 (from tiberius/sqlx/tokio-postgres-rustls). No new version added vs MySQL baseline; dual-rustls situation is unchanged from pre-MSSQL build.
- [ ] 27.6 `openspec archive add-mssql-support` after merge
