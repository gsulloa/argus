## Context

Argus today ships first-class support for three relational backends: Postgres (`tokio-postgres` + `deadpool-postgres` + `rustls`), MySQL / MariaDB (`sqlx::MySql` + `rustls`), and DynamoDB (`aws-sdk-dynamodb`). Each backend lives as a parallel module under `src-tauri/src/modules/<kind>/` (Rust) and `src/modules/<kind>/` (React/TS) with no shared abstraction layer; the connection registry (SQLite + OS keychain) is driver-agnostic and stores `params` as opaque JSON keyed by a `kind` string.

The MySQL change (`add-mysql-support`, shipped) established the pattern: replicate the Postgres module shape, localize dialect deltas (identifier quoting, placeholder syntax, error mapping, `INFORMATION_SCHEMA` queries, no-`RETURNING`) inside the driver module, and integrate via `kind === "..."` branches in cross-cutting code.

This change adds MS SQL Server (and Azure SQL Database / Managed Instance) support reaching feature parity with the existing surface: typed params, URL parsing, test/connect/disconnect, pool registry with read-only enforcement, schema browser, data grid + inline editor, SQL editor with `GO` batch handling, table structure subtab, and bulk columns cache for autocomplete. This design captures the architecture choices, the dialect deltas vs. MySQL / Postgres, and the cross-cutting integration points.

The key novel constraints vs. the existing drivers:

- **Wire protocol**: TDS (Tabular Data Stream), Microsoft proprietary. The only mature pure-Rust client is `tiberius`. `tiberius` uses `futures::io::AsyncRead/AsyncWrite` while the rest of Argus is on `tokio::io::AsyncRead/AsyncWrite`; bridging requires `tokio_util::compat`.
- **No first-class connection pool in `tiberius`**: a pool layer is required. `bb8-tiberius` is the de-facto choice.
- **Schema vocabulary**: SQL Server distinguishes _database_ (top-level container, chosen at connect time) from _schema_ (namespace within a database, e.g. `dbo`, `sales`). A single connection is scoped to one database; cross-database queries are possible but require fully-qualified `[db].[schema].[table]` names. This is the inverse of MySQL where "schema" and "database" are synonyms.
- **Errors are not SQLSTATE**: SQL Server uses numeric error codes (e.g. 18456 = login failed, 547 = constraint violation, 1205 = deadlock victim, 2627 = unique-key violation, 2601 = duplicate key). We carry the numeric code + class + state + line in our error envelope.
- **Cancellation**: TDS has an in-protocol Attention packet. `tiberius` exposes it as `Client::cancel()`-style behavior on token cancellation; we also support `KILL <spid>` from a fresh connection as a fallback.
- **`OUTPUT` instead of `RETURNING`**: edits can return refreshed rows in the same statement, so the MySQL re-fetch pattern is not needed.
- **`GO` batch separator**: a client-side directive, not SQL. Multi-statement runs must split on `GO` (case-insensitive, line-leading) and run each batch separately.
- **Statement terminator**: `;` is supported but historically optional. We require `;` in our splitter but tolerate omission at the end of a batch.

## Goals / Non-Goals

**Goals:**

- Reach behavioral parity with the Postgres / MySQL capabilities for users of MS SQL Server 2017+, Azure SQL Database, and Azure SQL Managed Instance.
- Add MS SQL Server as a peer to the existing per-driver modules without refactoring the parallel-module pattern. No premature shared abstraction layer.
- Use a single async TDS driver (`tiberius`) with an explicit pool (`bb8` + `bb8-tiberius`), rustls TLS, and the same connection lifecycle envelope MySQL / Postgres use (eager handshake, registry, `active-changed` event).
- Keep all dialect divergences (square-bracket quoting, `@P1` placeholders, numeric error codes, `INFORMATION_SCHEMA` + `sys.*` queries, `OUTPUT` clause, `GO` batches, `OFFSET ... FETCH NEXT` pagination, identity / `SCOPE_IDENTITY()` handling) localized to the `mssql` module.
- Reuse cross-cutting capabilities unchanged: connection registry, connection groups, command palette, table quick switcher, query history, saved queries, activity log, column-width preferences.
- Type binding for both the grid (decode) and the editor (bind), covering MS SQL Server's full type set including `UNIQUEIDENTIFIER`, `XML`, `JSON` (2025+), `ROWVERSION`, `DATETIMEOFFSET`, `MONEY`, and decode-only support for `GEOMETRY` / `GEOGRAPHY` / `HIERARCHYID` (WKT / string fallback).
- TLS via `rustls`, matching the Postgres / MySQL approach. SQL Server's TDS encryption modes (`Encrypt=true|false|strict`) map onto our `EncryptMode` enum.
- SQL Authentication only in v1. Form supports user / password.

**Non-Goals:**

- Generic `DatabaseDriver` trait or shared pool registry across drivers. Out of scope; revisit only if a fourth SQL driver lands.
- Windows Authentication (NTLM, SSPI, Kerberos). Out of scope for v1 — requires platform-specific crates (`libgssapi-sys` / `winauth`) and per-OS testing matrix. Documented as future work.
- Azure AD / Entra ID authentication, Managed Identity, access-token auth. Out of scope for v1; documented as future work. Users on Azure SQL must use a SQL-authentication login for v1.
- Always Encrypted (column-level encryption with client-side key vault). Out of scope.
- Linked-server traversal, distributed transactions, MSDTC. Out of scope.
- Stored-procedure / function editor. Read-only viewer is in scope (signature + body via `OBJECT_DEFINITION()` in placeholder tab); a full editor is not.
- Cross-database queries with `JOIN` autocomplete spanning databases. Autocomplete pre-warms only the connected database; the user may manually trigger pre-warm for additional schemas within the same database.
- Live replication / CDC tail, query store visualization, execution-plan rendering. The editor surfaces raw `SET SHOWPLAN_TEXT ON` / `SET STATISTICS XML ON` output as rows with no special rendering.
- Migration tooling, schema diffing, ER diagrams.
- `BACKUP` / `RESTORE` / `BCP` / bulk-copy operations.
- Table-valued parameters (TVPs) in the edit pipeline. Single-row binding only.

## Decisions

### D1. Driver: `tiberius` over `odbc-api` / `jdbc`

- **Choice**: Use `tiberius` (`features = ["rustls", "chrono", "time", "bigdecimal", "sql-browser-tokio"]`) bridged to `tokio` via `tokio_util::compat::TokioAsyncReadCompatExt` / `TokioAsyncWriteCompatExt`.
- **Why**: `tiberius` is the only mature pure-Rust TDS client. It is async-first, supports both SQL Auth and (with extra deps) Windows / AAD auth, ships rustls TLS, and decodes the full TDS type system. `odbc-api` would require shipping the Microsoft ODBC Driver as a runtime dependency (CGo-style platform fragility, blocked on user-installed driver bits). JDBC is a non-starter in a Rust desktop app.
- **Alternatives considered**: `odbc-api` (rejected: per-platform driver install, large opaque dependency, harder to ship in a Tauri bundle); a wrapper around the Microsoft `mssql-jdbc` driver via a JNI bridge (rejected: ships a JVM); building TDS from scratch (rejected: massive scope creep).
- **Cost**: `tiberius` has not had a major release in ~12 months at time of writing; the `0.12.x` line is the current stable. Pin the minor version and accept the maintenance posture. Documented as a risk.

### D2. Connection pool: `bb8` + `bb8-tiberius` wrapped in `MssqlPoolRegistry`

- **Choice**: Mirror `MysqlPoolRegistry`: a process-global `MssqlPoolRegistry` (singleton in Tauri `State`) holding `RwLock<HashMap<Uuid, ActiveMssqlPool>>`. Each `ActiveMssqlPool` owns a `bb8::Pool<bb8_tiberius::ConnectionManager>` (`min=1, max=4`), server version string, `read_only` flag, `encrypt_mode`, and `connected_at` timestamp.
- **Why**: Direct structural parity with MySQL simplifies code review and reuses the same lifecycle invariants (idempotent connect, eager handshake, drop on disconnect, snapshot under write lock for `disconnect_all`).
- **Read-only enforcement**: `bb8::ManageConnection::on_acquire` is not a thing in `bb8`, so we run the read-only sentinel SET via an explicit post-connect hook in our `ConnectionManager::connect` wrapper. The session runs `SET TRANSACTION ISOLATION LEVEL READ COMMITTED;` and we install a `SET LOCK_TIMEOUT 0;` guard so that mutating statements are caught at the registry boundary before they reach the wire. Higher-level callers (`mssql_apply_table_edits`) check the pool's `read_only` flag BEFORE dispatching any SQL — defense-in-depth, identical to MySQL.
- **Azure SQL ApplicationIntent**: When `params.read_only == true` and the server is Azure SQL or a Read Replica, we set `ApplicationIntent=ReadOnly` on the underlying `Config`. This routes the connection to the read-only replica when one is available, which is the idiomatic Azure pattern.

### D3. Identifier quoting and placeholder syntax

- **Identifiers**: All emitted SQL uses square brackets: `[schema].[table].[column]`. The quoting helper MUST escape an embedded `]` by doubling it (`a]b` → `[a]]b]`). One helper, one rule, applied everywhere SQL is built (grid filters, editor inserts, edit ops, structure DDL fallback). Square brackets are universal (do not depend on the `QUOTED_IDENTIFIER` server setting).
- **Placeholders**: `tiberius` uses `@P1, @P2, ...` named-positional placeholders. The filter compiler emits `@P1, @P2, ...`; the edit-op SQL builder does the same. The frontend never builds SQL — only the backend.
- **Three-part vs two-part names**: We always emit two-part names (`[schema].[table]`) since each connection is scoped to one database. Cross-database access in user-supplied SQL is allowed but our generated SQL never crosses database boundaries.
- **Why**: Square brackets are the only safe MS SQL Server identifier quote (double-quotes are only valid when `QUOTED_IDENTIFIER ON`, which is the default but not guaranteed). `@P1` is the TDS wire protocol's named-positional placeholder.

### D4. Error mapping (numeric codes, not SQLSTATE)

We carry the SQL Server error envelope in `AppError::Mssql { code: Option<i32>, message: String, line: Option<u32>, procedure: Option<String> }`. Note: `code` is `i32` (the SQL Server error number), NOT a SQLSTATE string. Mapping table (anchors all error-handling decisions in the specs):

| Scenario | SQL Server code |
|---|---|
| Login failed (wrong password / user) | 18456 |
| Cannot open database | 4060 |
| Connection refused / DNS / no route | none (driver error, `code: None`) |
| TLS handshake failed | none (driver error, `code: None`) |
| Syntax error | 102, 103, 105, 156, 170, 174 |
| Invalid object name (table / view) | 208 |
| Invalid column name | 207 |
| Constraint violation generic | 547 |
| Unique-key violation | 2627 |
| Duplicate key | 2601 |
| NOT NULL violation | 515 |
| String / binary truncation | 2628, 8152 |
| Numeric out of range | 8115 |
| Invalid date / time | 241, 242 |
| Read-only database / replica | 3906, 3908 |
| Query cancelled (Attention) | none (driver returns `Cancelled`) |
| Lock wait timeout | 1222 |
| Deadlock victim | 1205 |
| Login timeout / connection timeout | none (driver error) |

All cancellation paths surface `AppError::Mssql { code: None, message: "query cancelled", ... }` mapped from `tiberius::error::Error::Cancelled` (or our wrapper).

### D5. Query cancellation: TDS Attention + `KILL <spid>` fallback

- **Choice (primary)**: Wrap each cancellable query in `tokio::select!` against a cancellation token. On token fire, drop the query future — `tiberius` sends a TDS Attention packet during shutdown, which signals the server to abandon the current statement. The connection is then returned to the pool (or invalidated if the driver cannot guarantee state).
- **Choice (fallback)**: If the in-protocol cancel proves unreliable in practice (e.g. `tiberius` does not consistently issue Attention on future-drop in the pinned version), we issue `KILL <spid>` from a fresh, short-lived connection. The `spid` is captured at the start of each cancellable query via `SELECT @@SPID` and cached for the lifetime of the in-flight call.
- **Why**: SQL Server has first-class in-protocol cancellation (TDS Attention packet, equivalent to Postgres' `CancelRequest`). The `KILL` path is the safety net.
- **Cost**: One extra connection per cancellation event if the fallback fires. Acceptable because cancellations are user-initiated or timeout-triggered and rare in steady state.

### D6. Edit refresh: `OUTPUT` clause (no re-fetch round-trip)

- **Choice**: Use `OUTPUT INSERTED.*` for `INSERT`, `OUTPUT INSERTED.*` for `UPDATE`, and `OUTPUT DELETED.*` for `DELETE` to return the affected row(s) in the same round-trip.
- **Auto-increment / IDENTITY**: SQL Server auto-IDs come back through `OUTPUT INSERTED.*` directly — no need for a separate `SCOPE_IDENTITY()` round-trip. For tables with a single-column `IDENTITY` PK, the OUTPUT row provides the generated value.
- **Why**: Parity with Postgres' `RETURNING`. Saves the extra round-trip MySQL needs. The transaction is still wrapped around the entire batch so partial failure rolls back cleanly.
- **Edge case**: `OUTPUT` requires no triggers on the table that violate the `OUTPUT...INTO` restrictions. When a target table has a trigger and we get the SQL Server error 334 ("The target table 'X' of the OUTPUT clause cannot have any enabled triggers if the statement contains a DML statement without the INTO clause"), we degrade gracefully: rollback, retry the same edit op WITHOUT `OUTPUT`, then issue a `SELECT ... WHERE pk = ?` re-fetch (MySQL pattern). This is detected once per `(connection, schema.table)` and cached.

### D7. Type binding strategy

We need two type-binding pipelines: **decode** (grid result rows → JSON values for the frontend) and **bind** (JSON values from the frontend → bound parameter for INSERT / UPDATE).

**Decode (grid `mssql_query_table`)**: Per-column dispatch from `tiberius::ColumnData` / column type info:

- `BIT` → bool
- `TINYINT` / `SMALLINT` / `INT` → JSON number
- `BIGINT` → number if within safe-integer range (±2^53-1), else JSON string (same convention as MySQL `BIGINT`)
- `DECIMAL` / `NUMERIC` / `MONEY` / `SMALLMONEY` → JSON string (preserve precision)
- `FLOAT` / `REAL` → JSON number
- `CHAR` / `VARCHAR` / `TEXT` / `NCHAR` / `NVARCHAR` / `NTEXT` → JSON string
- `BINARY` / `VARBINARY` / `IMAGE` → JSON string (base64-encoded)
- `ROWVERSION` / `TIMESTAMP` → JSON string (base64-encoded; 8-byte binary)
- `DATE` → `"YYYY-MM-DD"`
- `TIME` → `"HH:MM:SS[.fffffff]"`
- `DATETIME` / `DATETIME2` / `SMALLDATETIME` → ISO 8601 with no timezone
- `DATETIMEOFFSET` → ISO 8601 with `±HH:MM` offset (preserve server's stored offset, do not normalize to UTC)
- `UNIQUEIDENTIFIER` → canonical lowercase `"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`
- `XML` → JSON string (XML text as-is)
- `JSON` (SQL Server 2025+) → parsed JSON value (not double-stringified)
- `GEOMETRY` / `GEOGRAPHY` → WKT string via `.STAsText()` (decode-only)
- `HIERARCHYID` → string via `.ToString()` (decode-only)
- `SQL_VARIANT` → JSON string (best-effort coercion via `CONVERT(NVARCHAR(MAX), col)`)
- Unknown → raw text fallback

**Bind (edit ops `mssql_apply_table_edits`)**: Per-column dispatch from the table's declared type (cached from `mssql_table_primary_key` + bulk columns):

- Integer family → bind as `i32` / `i64` (validate range against declared column type)
- `DECIMAL` / `NUMERIC` → bind as `bigdecimal::BigDecimal` parsed from string
- `MONEY` / `SMALLMONEY` → bind as `bigdecimal::BigDecimal` (server accepts decimal literal)
- `FLOAT` / `REAL` → bind as f64
- Strings (`CHAR` / `VARCHAR` / `NCHAR` / `NVARCHAR`) → bind as `&str`; for N-types tiberius handles UTF-16 conversion
- `TEXT` / `NTEXT` → bind as `&str` (deprecated types but still accept text bind)
- `BINARY` / `VARBINARY` / `IMAGE` → expect base64 from frontend; decode to bytes; bind as `&[u8]`
- `ROWVERSION` → reject as bind (read-only system type); v1 returns `AppError::Validation` if user tries to write to it
- `DATE` / `DATETIME` / `DATETIME2` / `SMALLDATETIME` → bind as `chrono::NaiveDateTime` / `NaiveDate` (tiberius converts)
- `TIME` → bind as `chrono::NaiveTime`
- `DATETIMEOFFSET` → bind as `chrono::DateTime<FixedOffset>`
- `UNIQUEIDENTIFIER` → expect canonical form; bind as `uuid::Uuid`
- `XML` → bind as `&str`
- `JSON` (2025+) → bind as `&str` (server parses)
- `BIT` → bind as bool
- `GEOMETRY` / `GEOGRAPHY` → out of scope for v1 edit (reject with typed error suggesting the SQL editor)
- `HIERARCHYID` → out of scope for v1 edit (reject)
- `SQL_VARIANT` → out of scope for v1 edit (reject)
- `IDENTITY` columns → not bindable directly on INSERT (unless `SET IDENTITY_INSERT [t] ON` — not supported in v1); reject Insert ops that supply IDENTITY column values
- NULL → bind as SQL NULL
- Unknown → bind as string

### D8. Schema-browser dialect deltas

- **Vocabulary**: Use "schema" in spec / API; the frontend tree shows "Schemas" as the section label for MS SQL Server connections. `INFORMATION_SCHEMA.SCHEMATA` / `sys.schemas` is the source. Each connection is scoped to one database (chosen at connect time); the schema browser lists the schemas within that database.
- **Database picker**: A one-line selector at the top of the schema browser shows the current database and offers a dropdown of all databases the user can access (`SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1`). Switching database issues a new `USE [db]` on the active pool and refreshes the schema tree. v1 binds the database choice at connect time; the runtime switcher is a follow-up if scope allows.
- **System schemas**: `sys`, `INFORMATION_SCHEMA`, `db_owner`, `db_accessadmin`, `db_securityadmin`, `db_ddladmin`, `db_backupoperator`, `db_datareader`, `db_datawriter`, `db_denydatareader`, `db_denydatawriter`, `guest`. All hidden by default; user can opt in via the picker (same UX as Postgres' `pg_*` and MySQL's `mysql/sys`).
- **Relations**: tables + views only (no materialized views; SQL Server has indexed views but they appear as views with `IS_INDEXED=true` — surface as a sub-flag, not a separate bucket). Use `INFORMATION_SCHEMA.TABLES` + `sys.tables` for the partition flag (`sys.partitions.partition_number > 1`).
- **Estimated rows**: `sys.dm_db_partition_stats.row_count` summed across all partitions for the heap / clustered index. Surface as approximate. No `COUNT(*)` fallback.
- **Structure buckets**: replace MySQL's `routines / triggers / events` with `procedures / functions / triggers / sequences` (MS SQL Server has all four as first-class objects). Sources: `sys.procedures`, `sys.objects WHERE type IN ('FN','IF','TF','FS','FT')`, `sys.triggers`, `sys.sequences`.
- **Procedures vs functions**: separate buckets (unlike MySQL's combined `ROUTINES`). Each has its own kind badge inside the bucket if needed (`SCALAR_FUNCTION`, `INLINE_TABLE_VALUED_FUNCTION`, `TABLE_VALUED_FUNCTION`).
- **Routines overloadable?**: No. Identified by `(schema, name)`. No OID equivalent; `object_id` is stable within a database but not portable. Signature lookup via `sys.parameters` joined with `sys.types`.
- **Table extras**: indexes (including clustered / non-clustered / unique / filtered), triggers, foreign keys, check constraints, default constraints. Sources: `sys.indexes` + `sys.index_columns`, `sys.triggers`, `sys.foreign_keys` + `sys.foreign_key_columns`, `sys.check_constraints`, `sys.default_constraints`.

### D9. Table structure: prefer `sys.*` + `OBJECT_DEFINITION` for raw DDL

- **Choice**: SQL Server has no `SHOW CREATE TABLE` equivalent. For the "Raw" structure subtab, we synthesize the `CREATE TABLE` statement by stitching together `sys.columns`, `sys.indexes`, `sys.foreign_keys`, `sys.check_constraints`, `sys.default_constraints`, and table options. For views, procedures, functions, and triggers we use `OBJECT_DEFINITION(object_id)` which returns the original source text verbatim.
- **Why**: SSMS's `Script Table As → CREATE` is a thousand-line stored procedure (`sp_helpscript`) we cannot replicate exactly. v1 ships a reasonable synthesized DDL covering the most common cases (columns + PK + UNIQUE + FK + indexes + check constraints + default constraints + IDENTITY) and falls back to `sp_help [schema.table]` output for the structured subtab. A "full DDL" affordance is a v2 nice-to-have.
- **Alternative considered (rejected)**: Shell out to `mssql-scripter` / `sqlpackage`. Rejected — external binary, platform-fragile, large.

### D10. SQL editor statement splitting: `GO` batches

- **Choice**: The MS SQL Server splitter has two levels:
  1. **Batch level**: Split on `GO` (case-insensitive, optionally followed by an integer repeat count, must be on its own line with only whitespace before / after). `GO` is a client directive, never sent to the server.
  2. **Statement level (within a batch)**: Split on `;` honoring single-quoted strings, double-quoted strings (`QUOTED_IDENTIFIER ON` assumed), square-bracket-quoted identifiers (`[a;b]` is one identifier), `--` line comments, `/* */` block comments. Square-bracket-quoted identifiers may contain semicolons; the splitter must not split inside.
- **DDL batches**: `CREATE PROCEDURE / FUNCTION / TRIGGER / VIEW` in SQL Server require the statement to be the first statement in its batch. Our splitter respects this: if it sees one of these keywords mid-batch (after another `;`-separated statement), it returns `AppError::Validation { message: "CREATE PROCEDURE/FUNCTION/TRIGGER/VIEW must be the first statement in its batch; insert a 'GO' separator before it" }`.
- **Comment handling**: SQL Server supports `--` line comments and `/* */` block comments. Nested block comments are allowed; the splitter tracks nesting depth.
- **Why**: `GO` is iconic SQL Server tooling behavior (SSMS, `sqlcmd`). Users expect it. The simpler "no GO support" rule would force users to manually run each batch.

### D11. Pagination: `OFFSET ... FETCH NEXT`

- **Choice**: All grid queries use `ORDER BY <pk> OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`. Requires `ORDER BY`. If the user has not specified an order, we default to the table's primary key columns ascending. If the table has no PK (heap), we default to `(SELECT NULL)` — `OFFSET 0` works but `FETCH NEXT N` requires _some_ `ORDER BY`. We emit `ORDER BY (SELECT NULL)` as the fallback (this is the SSMS-idiomatic "no order" cheat).
- **Why**: `OFFSET ... FETCH NEXT` is the SQL-2008-standard pagination and the recommended SQL Server pattern from 2012+. Compatible with all supported server versions (2017+).
- **Performance**: Large `OFFSET` is O(offset) on the server. Same caveat as Postgres / MySQL — we don't try to optimize deep pagination in v1.

### D12. Frontend module organization

Mirror `src/modules/mysql/` structure under `src/modules/mssql/`:

```
src/modules/mssql/
├── types.ts                  # MssqlParams, ConnectResult, EncryptMode, etc.
├── api.ts                    # mssqlApi command wrappers
├── ConnectionForm.tsx        # Connection form (port default 1433, encrypt select, trust_cert toggle)
├── ConnectionForm.module.css
├── FormController.tsx
├── commands.ts               # Tauri command name constants
├── useActiveConnections.ts
├── useMssqlTabLifecycle.ts
├── icon.tsx                  # MssqlIcon (database + small flag/server silhouette, hairline strokes, currentColor)
├── openMssqlQueryTab.ts
├── MssqlObjectPlaceholderTab.tsx
├── schema/
│   ├── api.ts, SchemaTree.tsx, useSchemaTree.ts, globalSchemaCache.ts, useVisibleSchemas.ts, openObjectTab.ts
├── data/
│   ├── api.ts, TableViewerTab.tsx, DataGrid.tsx, useTableData.ts, FilterBar.tsx, EditableCell.tsx, types.ts, useEditBuffer.ts
├── sql/
│   ├── api.ts, QueryEditor.tsx, QueryTab.tsx, ResultPanel.tsx, useQueryRun.ts, completionSources.ts, MultiStatementTabs.tsx
├── structure/
│   ├── StructureSubtab.tsx, RawSubtab.tsx, useTableStructureCache.ts
└── columns/
    └── (bulk columns cache; same shape as mysql/columns)
```

Cross-cutting code (sidebar connection list, tab router, command palette registry, table quick switcher, query history, saved queries, activity log) gains a `kind === "mssql"` branch alongside the existing `"postgres"` / `"mysql"` / `"dynamodb"` branches. No shared abstraction layer is introduced.

### D13. Sidebar `MssqlIcon` design

- Stylized "server stack with a tiny flag" silhouette, hairline strokes (`stroke-width: 1.5`, `stroke="currentColor"`, no fills except optional ≤1px detail nodes), 24×24 viewBox, default size 16, `role="img"`, `aria-label="MS SQL Server"`. Inherits color via `currentColor`.
- Visually distinguishable at 14px from `PostgresIcon` (elephant), `MysqlIcon` (dolphin), and `DynamoIcon` (stacked cylinders) without color cues. The server-rack shape with a flag pennant reads as the iconic "Microsoft enterprise database" affordance and is clearly distinct from the three existing icons. We deliberately avoid the literal Microsoft "running man" SQL Server logo (trademarked and busy at 14px).

### D14. Activity log & event taxonomy

- Event name stays `argus:activity-log` (shared infra).
- New `kind` values: `test_connection`, `connect`, `disconnect`, `list_schemas`, `list_relations`, `list_structure`, `list_table_extras`, `get_routine_signature`, `query_table`, `count_table`, `apply_table_edits`, `table_structure`, `table_ddl`, `run_sql`, `run_sql_many`, `list_columns_bulk`. Identical to MySQL's surface where they overlap.
- Activity-log entries are tagged `kind_namespace: "mssql"` so the viewer can filter.
- New Tauri event `mssql:active-changed` (peer to `mysql:active-changed`).

### D15. Cargo dependencies

Add to `src-tauri/Cargo.toml`:

```toml
tiberius = { version = "0.12", default-features = false, features = [
  "rustls",
  "chrono",
  "time",
  "bigdecimal",
  "sql-browser-tokio",
  "tds73",
] }
bb8 = "0.8"
bb8-tiberius = "0.15"
tokio-util = { version = "0.7", features = ["compat"] }
```

Keep `tokio-postgres`, `deadpool-postgres`, `sqlx`, `rustls`, `tokio-postgres-rustls`, `webpki-roots`, `rustls-pki-types` exactly as today. **Verify** `tiberius`'s `rustls` feature pulls a version compatible with the existing stack — if it pulls yet another major `rustls` version, we accept the additional binary cost (documented in the trade-offs section) and revisit when `tiberius` updates.

A new Cargo feature `live-mssql-tests` mirrors `live-pg-tests` / `live-mysql-tests`, gated on `MSSQL_TEST_URL` environment variable. An optional `MSSQL_TEST_TRUST_CERT=1` env var enables trusting self-signed certs for local Docker SQL Server images (which ship a self-signed cert by default).

### D16. Connection storage: zero schema change

The SQLite `connections` table already stores `kind` and opaque `params_json`. No migration is needed. MS SQL Server connections are stored with `kind: "mssql"` and the JSON-serialized `MssqlParams`. The `connection-registry` capability is unchanged.

### D17. URL parsing: three accepted shapes

`mssql_parse_url(input)` accepts three input shapes and normalizes to `MssqlParams`:

1. **`mssql://` URL** — our canonical form. Example: `mssql://sa:Pass!@host:1433/MyDb?encrypt=true&trust_server_certificate=false`.
2. **`sqlserver://` URL** — alias for `mssql://`. The JDBC `jdbc:sqlserver://` form is also accepted (we strip the `jdbc:` prefix).
3. **ADO.NET key=value connection string** — what `TablePlus`, Azure Data Studio, and SSMS users will most often have on hand. Example: `Server=tcp:host,1433;Database=MyDb;User Id=sa;Password=Pass!;Encrypt=True;TrustServerCertificate=False;`. The parser is case-insensitive on keys and accepts the synonyms documented at https://learn.microsoft.com/en-us/dotnet/api/system.data.sqlclient.sqlconnection.connectionstring (Server == Data Source == Addr == Address; User Id == Uid == User; Initial Catalog == Database; etc.).

Unrecognized query / connection-string params are warned about but not fatal (so paste-from-TablePlus works even when the URL carries vendor metadata like `statusColor`, `tLSMode`, `driverVersion`).

### D18. EncryptMode handling

`EncryptMode` enum has three variants matching the .NET SqlClient v4+ surface:

- `Off` — no TLS. Server may reject if it requires encryption; we surface the error verbatim.
- `On` (default) — TLS for the entire connection. Equivalent to `Encrypt=true` (the modern default).
- `Strict` — TLS-before-login (TDS 8.0 strict encryption). Used by Azure SQL with the strict-encryption requirement. Sends the TLS ClientHello first, before any TDS prelogin.

Combined with `trust_server_certificate: bool` (default `false`), we have four practical configurations:

| EncryptMode | trust_server_certificate | Verifies hostname | Verifies CA | Notes |
|---|---|---|---|---|
| Off | n/a | n/a | n/a | No TLS |
| On | false | yes | yes (Mozilla roots) | Default; safe; works with public CAs |
| On | true | no | no | Encryption-only; matches `Required` in MySQL terms; needed for local Docker SQL Server |
| Strict | false | yes | yes | Azure SQL strict mode |
| Strict | true | no | no | Rare; allowed for diagnostics |

Mozilla roots come from the same `webpki-roots` crate Postgres uses.

### D19. Read-only enforcement layering

Three layers, defense-in-depth:

1. **Registry boundary**: `MssqlPoolRegistry::execute_mutation` checks `params.read_only` and returns `AppError::Validation { message: "connection is read-only" }` BEFORE acquiring a client.
2. **Edit pipeline**: `mssql_apply_table_edits` checks `read_only` and returns the same validation error before opening a transaction.
3. **Server-side session**: For Azure SQL replicas, we set `ApplicationIntent=ReadOnly` in the connection params so the gateway routes us to a read-only replica. For non-Azure servers, we wrap mutating statements in `BEGIN TRAN; ... ROLLBACK;` only at the application layer (no session-level read-only switch — SQL Server has `SET TRANSACTION READ ONLY` only inside an explicit transaction, not session-wide).

The frontend additionally hides edit affordances when `read_only` is `true` so the user does not get rejected at apply time.

## Risks / Trade-offs

- **[`tiberius` maintenance posture is moderate]** → Mitigated by pinning the minor version, tracking upstream, and being willing to fork small patches if needed. The crate has multiple production users (e.g. Prisma's MS SQL adapter) and is unlikely to bit-rot, but it does not move as fast as `sqlx` or `tokio-postgres`. Document as accepted risk.
- **[`tiberius` uses `futures::io::AsyncRead/AsyncWrite`, requiring a compat layer]** → Mitigated by `tokio_util::compat`. Adds one wrapping step in the pool's `ConnectionManager` and a small allocation cost per call. Negligible.
- **[Three SQL driver libraries in the binary (tokio-postgres + sqlx + tiberius)]** → Estimated +1.2–1.8 MB on the release binary. Unifying on a single async driver is out of scope and would force a refactor of Postgres or MySQL. Accept the binary growth.
- **[Possible third `rustls` major version pulled by `tiberius`]** → After `add-mysql-support` we already have `rustls 0.21.12` (sqlx) + `rustls 0.23.39` (tokio-postgres-rustls). If `tiberius` pulls yet another version, we accept it (same logic as design D14 / Q1 in the MySQL change). Documented; revisit when the ecosystem converges.
- **[Lack of Windows Authentication]** → v1 ships SQL Auth only. Enterprises that mandate Windows / AAD auth cannot use Argus for those connections yet. Documented as a known limitation; the form clearly states "SQL Authentication" and points to a planned follow-up change.
- **[Lack of Azure AD / Entra ID auth]** → Same as above. Critical for Azure SQL users who have disabled SQL Auth. Documented and deferred.
- **[`OUTPUT` clause incompatible with tables that have triggers]** → Mitigated by graceful degradation (D6): catch SQL error 334, retry without `OUTPUT`, then re-fetch via `SELECT WHERE pk = ?` like the MySQL pipeline does. Cache the degradation per `(connection, schema.table)` so we only pay the round-trip on the first edit.
- **[`INFORMATION_SCHEMA` + `sys.*` views can be slow on busy servers]** → Mitigated by `tokio::join!`-based partial-degradation envelope with per-query 8s timeout, total 10s, surfacing per-kind failures. Same pattern as Postgres / MySQL.
- **[SQL Server 2017 vs 2019 vs 2022 vs Azure SQL feature drift]** → v1 targets 2017+. Some features (JSON column type — 2025+, `STRING_AGG` — 2017+, `APPROX_COUNT_DISTINCT` — 2019+) require newer servers. The editor surfaces server errors verbatim — no version-specific feature gating in v1. The schema browser uses only views / DMVs available in 2017+.
- **[Estimated row counts from `sys.dm_db_partition_stats` are approximate]** → Surface as-is with the "approximate" UI label. Identical posture to MySQL `INFORMATION_SCHEMA.TABLES.TABLE_ROWS`.
- **[Spatial / hierarchyid / sql_variant edit not supported in v1]** → The grid decodes them as WKT / string; the edit pipeline rejects writes with a typed error pointing to the SQL editor.
- **[Multi-batch DDL needs `GO` separator]** → Documented in D10. v1 cost is a clear error message; v2 may add inference (auto-insert `GO` before `CREATE PROCEDURE` etc.).
- **[Azure SQL Database has subtly different surface]** → Some `sys.*` views are restricted (`sys.server_principals` etc.) and some operations (USE database, certain DDL) behave differently. v1 detects Azure SQL at handshake (`SELECT SERVERPROPERTY('EngineEdition')` returns `5` for Azure SQL Database, `8` for Managed Instance) and conditionally skips the gated views with `tracing::warn!`.
- **[Schema vocabulary drift: "Schema" vs "Database" vs "Catalog"]** → SQL Server has both database (catalog) and schema. The spec uses "schema" for the in-database namespace and "database" for the top-level container; the UI uses "Schemas" as the section label inside the connected database. The database picker uses "Database". This matches SSMS terminology.

## Migration Plan

No data migration. Connection storage and OS keychain are unchanged. Ship in a single PR alongside its tests. Rollback is a code revert — no on-disk state is created.

Release notes for users: highlight the new MS SQL Server connection form, list supported servers (SQL Server 2017+, Azure SQL Database, Azure SQL Managed Instance), call out:

- SQL Authentication only in v1 (no Windows Auth / Azure AD yet)
- `Encrypt=true` is the default
- `GO` separator required for multi-batch DDL
- `OUTPUT`-clause edit refresh degrades to re-fetch on tables with triggers
- `TINYINT` is unsigned 0–255 in SQL Server (unlike MySQL `TINYINT` which is signed -128–127). No bool convention on `TINYINT(1)` — `BIT` is the canonical boolean type.

## Open Questions

- **Q1: `rustls` version alignment with `tiberius`.** Need to inspect `Cargo.lock` after adding `tiberius`. If it pulls a third major `rustls` version, accept it as in the MySQL change. Resolve during Phase A scaffolding.
- **Q2: bb8-tiberius vs hand-rolled pool.** `bb8-tiberius` is the obvious choice but is a thin wrapper that has had update lag in the past. If pinned versions cause grief during Phase A, fall back to a hand-rolled pool that mirrors the `MysqlPoolRegistry` internals. Decide before Phase B.
- **Q3: Default EncryptMode for new connections.** Proposal recommends `On` + `trust_server_certificate: false`. Local Docker `mcr.microsoft.com/mssql/server` images ship a self-signed cert by default — users will hit a TLS verification error and need to flip `trust_server_certificate: true`. Document prominently in the form's helper text. Confirm before the form lands.
- **Q4: Database picker UX.** Bind the database at connect time (form has a `Database` field, required) vs. let the user switch databases after connect via a dropdown in the schema browser. v1 proposal: bind at connect time (simpler, matches SSMS's "Connect to: Server / Database" dialog). Confirm before specs land.
- **Q5: `IDENTITY_INSERT` for inserting explicit PK values.** SQL Server requires `SET IDENTITY_INSERT [t] ON` before inserting into an IDENTITY column. v1 rejects such inserts with a typed error pointing to the SQL editor. Confirm before edit pipeline ships.
- **Q6: TDS version.** `tiberius` defaults to TDS 7.4. Some Azure SQL features prefer TDS 7.4+ (recent connect-string options). The `tds73` feature flag enables TDS 7.3 (broader compatibility). Default proposal: enable `tds73` to maximize compatibility, since `tiberius` negotiates upward at handshake when the server supports it.
- **Q7: `sp_help` output parsing.** The structured subtab needs typed access to columns / constraints / indexes. We have two options: parse `sp_help [t]` output (compact, one stored procedure call, but multi-result-set with positional columns that have changed across SQL Server versions) or hit `sys.columns` + `sys.indexes` + `sys.foreign_keys` etc. directly (typed, version-stable, more queries). Proposal: hit `sys.*` directly, the same way the MySQL change hits `INFORMATION_SCHEMA` directly. Confirm before the structure capability lands.
