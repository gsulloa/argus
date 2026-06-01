## Context

Argus today ships first-class Postgres support: a Rust `modules/postgres/` module built on `tokio-postgres` + `deadpool-postgres` + `rustls`, a React `modules/postgres/` module with a connection form, schema browser, virtualized data grid, inline editor, SQL editor, and structure subtab. DynamoDB is implemented as a parallel module with no shared abstraction layer over Postgres. The connection registry (SQLite + OS keychain) is driver-agnostic and stores `params` as opaque JSON keyed by a `kind` string.

The proposal adds MySQL (and MariaDB) support reaching feature parity with the Postgres surface: typed params, URL parsing, test/connect/disconnect, pool registry with read-only enforcement, schema browser, data grid + inline editor, SQL editor, table structure subtab, and bulk columns cache for autocomplete. This design captures the architecture choices, the dialect deltas vs. Postgres, and the cross-cutting integration points.

## Goals / Non-Goals

**Goals:**

- Reach behavioral parity with the Postgres capabilities for users of MySQL ≥ 5.7 and MariaDB ≥ 10.5.
- Add MySQL as a peer to Postgres / DynamoDB without refactoring the existing per-driver module pattern. No premature shared abstraction layer.
- Use a single async MySQL driver (`sqlx::MySql`) with built-in pooling, rustls TLS, and the same connection lifecycle envelope Postgres uses (eager handshake, registry, `active-changed` event).
- Keep all dialect divergences (identifier quoting, placeholder syntax, SQLSTATE codes, `INFORMATION_SCHEMA` queries, no-`RETURNING`) localized to the `mysql` module.
- Reuse cross-cutting capabilities unchanged: connection registry, connection groups, command palette, table quick switcher, query history, saved queries, activity log, column-width preferences.
- Type binding for both the grid (decode) and the editor (bind), covering MySQL's full type set including `JSON`, `BIT`, `DECIMAL`, `BLOB`, spatial types (WKT fallback), `ENUM`/`SET`.
- TLS via `rustls`, matching the Postgres approach, with five `ssl_mode` values (`disabled | preferred | required | verify-ca | verify-identity`).

**Non-Goals:**

- Generic `DatabaseDriver` trait or shared pool registry across drivers. Out of scope for this change; revisit only if a third SQL driver lands.
- MariaDB-specific features beyond the union with MySQL (e.g., `INSERT...RETURNING`, sequence objects, dynamic columns). The driver MUST accept MariaDB servers without breakage, but feature support follows the MySQL contract.
- Stored-procedure / stored-function editor. Read-only viewer is in scope (signature + body in placeholder tab); a full editor is not.
- Cross-database queries with `JOIN` autocomplete spanning schemas. Autocomplete pre-warms only the default schema; the user may manually trigger pre-warm for additional schemas.
- Live replication / binlog tail. Read/edit grid only.
- MySQL `EXPLAIN ANALYZE` visualization. The editor surfaces raw `EXPLAIN` output as a row set with no special rendering.
- Migration tooling, schema diffing, ER diagrams.

## Decisions

### D1. Driver: `sqlx::MySql` over `mysql_async` / `mysql`

- **Choice**: Use `sqlx` (`features = ["mysql", "runtime-tokio-rustls", "chrono", "bigdecimal", "uuid", "json"]`).
- **Why**: `sqlx` integrates `rustls` TLS without a third-party shim, provides a built-in `MySqlPool` with `min`/`max` connection bounds, exposes typed `Row` decoding with column metadata, and ships first-class support for `chrono`/`bigdecimal`/`json`. Its compile-time query macros are not used (we issue dynamic SQL), but its runtime API is mature and well-maintained. `mysql_async` is also production-quality but has a less ergonomic pool and a custom TLS path. The `mysql` crate is blocking and would require manual `tokio::task::spawn_blocking` wrapping for every query.
- **Alternatives considered**: `mysql_async` (rejected: extra rustls shim, less common in current Rust ecosystem); blocking `mysql` (rejected: cost of `spawn_blocking` per call, harder to plumb cancellation); a hand-rolled wire client (rejected: massive scope creep).

### D2. Connection pool: `sqlx::MySqlPool` wrapped in `MysqlPoolRegistry`

- **Choice**: Mirror `PgPoolRegistry`: a process-global `MysqlPoolRegistry` (singleton in Tauri `State`) holding `RwLock<HashMap<Uuid, ActiveMysqlPool>>`. Each `ActiveMysqlPool` owns a `sqlx::MySqlPool` (`min_connections=1, max_connections=4`), server version string, `read_only` flag, `ssl_mode`, and `connected_at` timestamp.
- **Why**: Direct structural parity with Postgres simplifies code review and reuses the same lifecycle invariants (idempotent connect, eager handshake, drop on disconnect, snapshot under write lock for `disconnect_all`).
- **Read-only enforcement**: `sqlx::PoolOptions::after_connect` hook runs `SET SESSION TRANSACTION READ ONLY;` on every freshly acquired connection when `params.read_only` is `true`. Higher-level callers (`mysql_apply_table_edits`) check the pool's `read_only` flag BEFORE dispatching any SQL — the post-connect SET is defense-in-depth.

### D3. Identifier quoting and placeholder syntax

- **Identifiers**: All emitted SQL uses backticks: `` `schema`.`table`.`column` ``. The quoting helper MUST escape an embedded backtick by doubling it (`a`b` → `` `a``b` ``). One helper, one rule, applied everywhere SQL is built (grid filters, editor inserts, edit ops, structure DDL fallback).
- **Placeholders**: All bound parameters use `?` positional placeholders (sqlx-native). The filter compiler emits `?`; the edit-op SQL builder emits `?`. The frontend never builds SQL — only the backend.
- **Why**: Backticks are the only safe MySQL identifier quote (double-quotes are configurable via `ANSI_QUOTES` SQL mode; we do not assume any mode). `?` is the wire protocol's positional placeholder.

### D4. SQLSTATE mapping

We carry a 5-character SQLSTATE in `AppError::Mysql { code: Option<String>, message, position }`. Code mapping table (anchors all error-handling decisions in the specs):

| Scenario | SQLSTATE |
|---|---|
| Access denied (wrong password / user) | `28000` |
| Connection refused / DNS / no route | none (driver error, `code: None`) |
| Syntax error | `42000` |
| Unknown column / table | `42S22` / `42S02` |
| Constraint violation (PK/UNIQUE/FK/NOT NULL) | `23000` |
| String data too long | `22001` |
| Numeric out of range | `22003` |
| Invalid date/time | `22007` |
| Read-only transaction | `25006` |
| Query interrupted (KILL QUERY / timeout) | `70100` |
| Lock wait timeout | `HY000` (with vendor 1205) |
| Generic | `HY000` |

Note that `70100` is the MySQL equivalent of Postgres `57014` (query_canceled). All timeout-cancellation paths surface it via `KILL QUERY <conn-id>` issued from a short-lived fresh connection that matches the original session's `ssl_mode`.

### D5. Query cancellation: out-of-band `KILL QUERY`

- **Choice**: Open a fresh, short-lived MySQL connection (matching the original's `ssl_mode`) and issue `KILL QUERY <thread_id>`. The thread id is captured at the start of each query via `SELECT CONNECTION_ID()` and cached for the lifetime of the in-flight call.
- **Why**: MySQL has no in-protocol cancellation (unlike Postgres' `CancelRequest`). `KILL QUERY` (vs. `KILL` which terminates the session) terminates only the in-flight statement on that thread, leaving the connection alive for the pool to reuse.
- **Cost**: One extra connection per cancellation event. Acceptable because cancellations are user-initiated or timeout-triggered and rare in steady state.

### D6. No `RETURNING` — re-fetch in-transaction

- **Problem**: Postgres' `mysql_apply_table_edits` analog uses `RETURNING` to ship back refreshed rows after Insert/Update. MySQL has no portable `RETURNING` clause (MariaDB 10.5+ has `INSERT...RETURNING` only; standard MySQL has none).
- **Choice**: Within the same transaction as the edit ops, issue a follow-up `SELECT ... WHERE pk = ?` (using new PK values for inserts via `LAST_INSERT_ID()`, or the supplied PK for updates and updates that change a PK column). Commit only after the re-fetch succeeds.
- **Cost**: One extra round-trip per touched row. Acceptable because edits are interactive and the row count per batch is small (typically 1–5 rows in the grid edit buffer).

### D7. Type binding strategy

We need two type-binding pipelines: **decode** (grid result rows → JSON values for the frontend) and **bind** (JSON values from the frontend → bound parameter for INSERT/UPDATE).

**Decode (grid `mysql_query_table`)**: Per-column dispatch from `sqlx::Column::type_info()`:

- `TINYINT(1)` → bool (MySQL convention for boolean columns)
- `TINYINT`/`SMALLINT`/`MEDIUMINT`/`INT` → JSON number
- `BIGINT` → number if within safe-integer range (±2^53-1), else JSON string
- `DECIMAL`/`NUMERIC` → JSON string (preserve precision)
- `FLOAT`/`DOUBLE` → JSON number
- `CHAR`/`VARCHAR`/`TEXT*` → JSON string
- `BINARY`/`VARBINARY`/`BLOB*` → JSON string (base64-encoded)
- `DATE` → `"YYYY-MM-DD"`
- `TIME` → `"HH:MM:SS[.fff]"`
- `DATETIME` → ISO 8601 with no timezone
- `TIMESTAMP` → ISO 8601 UTC (`Z` suffix)
- `YEAR` → JSON number
- `JSON` → parsed JSON value (not double-stringified)
- `ENUM`/`SET` → JSON string (SET is the comma-joined member list MySQL returns)
- `BIT(n)` → binary-digit string for `n ≤ 64`, hex string otherwise
- Spatial (`GEOMETRY`/`POINT`/etc.) → WKT string via `ST_AsText`
- Unknown → raw text fallback

**Bind (edit ops `mysql_apply_table_edits`)**: Per-column dispatch from the table's declared type (cached from `mysql_table_primary_key` + bulk columns):

- Integer family → bind as i64 (validate range)
- DECIMAL → bind as string; MySQL parses literal
- FLOAT/DOUBLE → bind as f64
- Strings → bind as `&str`
- BLOB / VARBINARY → expect base64 from frontend; decode to bytes; bind as `&[u8]`
- DATE/DATETIME/TIMESTAMP/TIME → bind as ISO 8601 string; let MySQL parse
- JSON → serialize to string and bind with explicit `CAST(? AS JSON)` to force the server type
- BOOLEAN / TINYINT(1) → bind as i64 (0/1)
- ENUM/SET → bind as string; server validates
- BIT → bind as i64 (from `"0b..."` or decoded hex); for n>64 reject with `AppError::Validation`
- GEOMETRY → out of scope for v1 edit (reject with typed error suggesting the SQL editor)
- NULL → bind as SQL NULL
- Unknown → bind as string

### D8. Schema-browser dialect deltas

- **Vocabulary**: Use "schema" in spec/API; the frontend tree shows "Databases" as the section label for MySQL connections. `SHOW DATABASES` / `INFORMATION_SCHEMA.SCHEMATA` is the source.
- **System schemas**: `mysql`, `information_schema`, `performance_schema`, `sys`.
- **Relations**: tables + views only (no materialized views). Use `INFORMATION_SCHEMA.TABLES`. Partitioned tables get `kind: "partitioned"` derived from `INFORMATION_SCHEMA.PARTITIONS`.
- **Estimated rows**: `INFORMATION_SCHEMA.TABLES.TABLE_ROWS` — surface as-is, note it is engine-dependent and inaccurate for InnoDB. No `COUNT(*)` fallback.
- **Structure buckets**: replace Postgres' `functions / types / extensions` with `routines (procedures+functions, one bucket with kind badge) / triggers / events`. MySQL has no extension system and no user-defined composite types in the same sense.
- **Routines**: not overloadable; identified by `(schema, name, kind)`, no OID equivalent. Signature lookup via `INFORMATION_SCHEMA.PARAMETERS`.
- **Table extras**: indexes, triggers, foreign keys (new bucket compared to Postgres' indexes+triggers). Sources: `STATISTICS`, `TRIGGERS`, `KEY_COLUMN_USAGE`+`REFERENTIAL_CONSTRAINTS`.

### D9. Table structure: prefer `SHOW CREATE TABLE` for raw DDL

- **Choice**: For the "Raw" structure subtab, call `SHOW CREATE TABLE \`s\`.\`r\`` (or `SHOW CREATE VIEW` for views) and return the server's canonical output verbatim.
- **Why**: Reconstructing DDL from `INFORMATION_SCHEMA` is error-prone — `SHOW CREATE` is the only fully-faithful source (carries options, comments, index hints, partition definitions, engine-specific clauses).
- **Structured subtab**: Still rendered from `INFORMATION_SCHEMA` joins (columns, indexes, FKs, triggers, options) for typed access in the UI.

### D10. SQL editor statement splitting

- **Choice**: Reuse the same client-side splitter the Postgres editor uses, with MySQL adaptations:
  - Recognize `# ...` line comments (MySQL-specific) in addition to `-- ` and `/* */`.
  - Backtick-quoted identifiers may contain semicolons; the splitter must not split inside.
  - Reject batches whose first keyword is `CREATE PROCEDURE`, `CREATE FUNCTION`, `CREATE TRIGGER`, or `CREATE EVENT` with `AppError::Validation { message: "DELIMITER blocks not supported in multi-statement runs; run as a single statement" }`. Single-statement runs work fine for routine creation because the entire body is sent as one statement via the `mysql_run_sql` path.
- **Why**: Full `DELIMITER` support requires a stateful parser. v1 ships with the simpler rule and a clear error message.

### D11. Frontend module organization

Mirror `src/modules/postgres/` structure under `src/modules/mysql/`:

```
src/modules/mysql/
├── types.ts                  # MysqlParams, ConnectResult, etc.
├── api.ts                    # mysqlApi command wrappers
├── ConnectionForm.tsx        # Connection form (port default 3306, ssl_mode select)
├── FormController.tsx
├── useActiveConnections.ts
├── icon.tsx                  # MysqlIcon (dolphin silhouette, hairline strokes, currentColor)
├── schema/
│   ├── api.ts, SchemaTree.tsx, useSchemaTree.ts, globalSchemaCache.ts, useVisibleSchemas.ts, openObjectTab.ts
├── data/
│   ├── api.ts, TableViewerTab.tsx, DataGrid.tsx, useTableData.ts, FilterBar.tsx, EditableCell.tsx, types.ts, useEditBuffer.ts
├── sql/
│   ├── api.ts, QueryEditor.tsx, QueryTab.tsx, ResultPanel.tsx, useQueryRun.ts, completionSources.ts
└── structure/
    ├── StructureSubtab.tsx, RawSubtab.tsx, useTableStructureCache.ts
```

Cross-cutting code (sidebar connection list, tab router, command palette registry, table quick switcher) gains a `kind === "mysql"` branch alongside the existing `"postgres"`/`"dynamodb"` branches. No shared abstraction layer is introduced.

### D12. Sidebar `MysqlIcon` design

- Dolphin silhouette, hairline strokes (`stroke-width: 1.5`, `stroke="currentColor"`, no fills except optional ≤1px detail nodes), 24×24 viewBox, default size 16, `role="img"`, `aria-label="MySQL"`. Inherits color via `currentColor`.
- Visually distinguishable at 14px from `PostgresIcon` (elephant) and `DynamoIcon` (stacked cylinders) without color cues — the dolphin's curving body + dorsal fin reads as an organic horizontal flow shape, clearly different from the elephant's vertical head+trunk profile.

### D13. Activity log & event taxonomy

- Event name stays `argus:activity-log` (shared infra).
- New `kind` values: `test_connection`, `connect`, `disconnect`, `list_schemas`, `list_relations`, `list_structure`, `list_table_extras`, `get_routine_signature`, `query_table`, `count_table`, `apply_table_edits`, `table_structure`, `table_ddl`, `run_sql`, `run_sql_many`, `list_columns_bulk`. Identical to Postgres' surface where they overlap.
- New Tauri event `mysql:active-changed` (peer to `postgres:active-changed`).

### D14. Cargo dependencies

Add to `src-tauri/Cargo.toml`:

```toml
sqlx = { version = "0.8", default-features = false, features = [
  "runtime-tokio-rustls",
  "mysql",
  "chrono",
  "bigdecimal",
  "json",
  "uuid",
  "macros",
] }
```

Keep `tokio-postgres`, `deadpool-postgres`, `rustls`, `tokio-postgres-rustls`, `webpki-roots`, `rustls-pki-types` exactly as today. The `sqlx` `rustls` provider shares `rustls` 0.23 with Postgres — verify version alignment to avoid duplicating the `rustls` crate in the binary.

A new Cargo feature `live-mysql-tests` mirrors `live-pg-tests`, gated on `MYSQL_TEST_URL` environment variable.

### D15. Connection storage: zero schema change

The SQLite `connections` table already stores `kind` and opaque `params_json`. No migration is needed. MySQL connections are stored with `kind: "mysql"` and the JSON-serialized `MysqlParams`. The `connection-registry` capability is unchanged.

## Risks / Trade-offs

- **[`sqlx` adds binary size, ~1.5–2 MB]** → Acceptable for parity. Postgres uses `tokio-postgres` which is leaner, but unifying both on `sqlx` is out of scope and risky. We accept two driver libraries in the binary.
- **[Lack of `RETURNING` doubles round-trips for edits]** → Mitigated by limiting edit batches to interactive sizes (typically ≤5 rows) and keeping the re-fetch inside the same transaction. Performance impact on hot paths is negligible.
- **[`KILL QUERY` needs a fresh connection per cancellation]** → Mitigated because cancellations are rare. The fresh-connection setup matches the original's `ssl_mode`, so cancel-path latency is similar to the test-connection latency budget (8s).
- **[`INFORMATION_SCHEMA` queries can be slow on large servers]** → Mitigated by `tokio::join!`-based partial-degradation envelope with per-query 8s timeout, total 10s, surfacing per-kind failures. Same pattern as Postgres' schema browser.
- **[MySQL 5.7 vs 8.0 vs MariaDB feature drift]** → v1 targets MySQL ≥ 5.7 and MariaDB ≥ 10.5. Some features (JSON column, window functions, EXPLAIN ANALYZE) require 8.0+. The editor surfaces server errors verbatim — no version-specific feature gating in v1.
- **[`TINYINT(1)` ambiguity]** → MySQL has no native bool; `TINYINT(1)` is convention. We always decode `TINYINT(1)` as bool in the grid; users with non-bool `TINYINT(1)` columns will see `true`/`false` values. Document as a known v1 quirk. Workaround: change column to `TINYINT(2)+`. A future setting could let users opt out.
- **[Spatial type editing not supported in v1]** → The grid decodes WKT; the edit pipeline rejects writes to spatial columns with a typed error pointing to the SQL editor.
- **[Stored routine multi-statement bodies need single-statement run mode]** → Documented in D10. v1 cost is a clear error message; v2 may add a stateful `DELIMITER` parser.
- **[Estimated row counts from `INFORMATION_SCHEMA.TABLES.TABLE_ROWS` are inaccurate for InnoDB]** → We surface them as-is with no `COUNT(*)` fallback. The UI labels them "approximate" wherever shown.
- **[Schema vocabulary drift: "Databases" vs "Schemas"]** → The spec uses "schema" internally; the UI uses "Databases" for MySQL. Mixed vocabulary in code comments is acceptable; the user-facing label is the only one that matters.

## Migration Plan

No data migration. Connection storage and OS keychain are unchanged. Ship in a single PR alongside its tests. Rollback is a code revert — no on-disk state is created.

Release notes for users: highlight the new MySQL connection form, list supported versions (MySQL ≥ 5.7, MariaDB ≥ 10.5), and call out the `TINYINT(1) → bool` convention and the multi-statement DELIMITER limitation.

## Open Questions

- **Q1: `sqlx` `rustls` provider vs. `tokio-postgres-rustls` version alignment.** RESOLVED for v1: dual-version accepted. `sqlx 0.8` + `runtime-tokio-rustls` pulls `tokio-rustls 0.24` → `rustls 0.21.12`, coexisting with `tokio-postgres-rustls 0.13` → `tokio-rustls 0.26` → `rustls 0.23.39`. Both compile and link cleanly (different major versions; Cargo treats as separate crates). Cost: ~1–1.5 MB extra binary + two TLS roots tables. Revisit when sqlx 0.8.x ships with `tokio-rustls 0.26`, or when bundle size becomes an issue.
- **Q2: MariaDB-specific `INSERT...RETURNING`.** Should we detect MariaDB at handshake (server version string contains "MariaDB") and use `INSERT...RETURNING` to save the re-fetch round-trip? v1 says no (keep the re-fetch path uniform). Revisit if profiling shows the round-trip matters.
- **Q3: Schema picker default visibility for system schemas.** Postgres hides `pg_*` and `information_schema` by default. MySQL's `sys` schema is technically user-installable and useful for performance debugging. v1 hides all four (`mysql`, `information_schema`, `performance_schema`, `sys`); user can opt in via the picker. Confirm with users before ship.
- **Q4: Default SSL mode for new connections.** Postgres defaults to `disable` in the form. For MySQL, propose default `preferred` (opportunistic TLS) since modern MySQL servers ship with TLS enabled. Decide before the form lands.
