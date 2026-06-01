## ADDED Requirements

### Requirement: List columns bulk command

The MS SQL Server module SHALL expose a Tauri command `mssql_list_columns_bulk(id, schema, origin?)` that returns column metadata for **every** browsable relation (table or view) in a schema within the connected database in a single round-trip. The optional `origin` argument MUST be `"user"` or `"auto"`, defaulting to `"auto"` (this command is typically fired in the background to populate the autocomplete cache).

The command MUST:

- Acquire a connection from the existing `MssqlPoolRegistry`, MUST NOT open a new connection.
- Run a single SQL query against `sys.columns` joined with `sys.tables` (and `sys.views`), `sys.schemas`, and `sys.types` to return typed column metadata for the named schema, ordered by relation name then `column_id`. (`INFORMATION_SCHEMA.COLUMNS` filtered by `TABLE_SCHEMA = @P1` is a permissible fallback; the `sys.*` form is preferred for stable behavior across Azure SQL editions and access to identity / computed flags.)
- Scope results to the connected database — MS SQL Server connections are bound to exactly one database at a time, so the query implicitly returns rows from the current database only.
- Group rows in Rust by relation name into a `BTreeMap<String, Vec<BulkColumnInfo>>`, preserving `column_id` order within each relation.
- Enforce a 10-second total timeout with a server-side cancellation on expiry; on timeout return an `AppError::Mssql` timeout variant.
- Behave identically on read-only connections — this command is a pure read.
- Emit exactly one `argus:activity-log` event before returning, with `kind: "list_columns_bulk"`, `kind_namespace: "mssql"`, `connection_id: <id>`, `origin: <origin argument>`, `sql: null`, `params: null`, `metric: { kind: "items", value: <total columns summed across relations> }` on success (`null` on failure), and `status` matching the result.

The response payload MUST be `{ schema: string, columns_by_relation: { [relation_name]: BulkColumnInfo[] } }` (snake_case keys), where `BulkColumnInfo` is:

```
{
  name: string,
  data_type: string,                  // full type name with size, e.g. "nvarchar(255)", "decimal(18,4)"
  base_type: string,                  // sys.types.name, e.g. "nvarchar", "decimal", "int"
  is_nullable: boolean,               // sys.columns.is_nullable
  is_identity: boolean,               // sys.columns.is_identity
  is_computed: boolean,               // sys.columns.is_computed
  column_default: string | null,      // raw default expression (sys.default_constraints.definition), null when absent
  character_max_length: number | null,// sys.columns.max_length normalized for n-char types, null otherwise
  comment: string | null,             // MS_Description extended property, null when absent
}
```

#### Scenario: Schema with mixed relations returns columns grouped per relation

- **WHEN** the schema `dbo` contains tables `Events`(3 cols) and `Sessions`(4 cols), and view `DailySummary`(2 cols)
- **AND** the user (or background flow) invokes `mssql_list_columns_bulk(id, "dbo")`
- **THEN** the response is `{ schema: "dbo", columns_by_relation: { Events: [3 entries], Sessions: [4 entries], DailySummary: [2 entries] } }`
- **AND** entries within each relation are ordered by `column_id`
- **AND** one `argus:activity-log` event is emitted with `kind: "list_columns_bulk"`, `kind_namespace: "mssql"`, `status: "ok"`, `metric: { kind: "items", value: 9 }`

#### Scenario: Identity, computed, and full type are surfaced

- **WHEN** a column `Users.Id` is an `INT IDENTITY(1,1) NOT NULL` primary key, and column `Users.FullName` is a `nvarchar(101)` `PERSISTED` computed column
- **AND** the user invokes `mssql_list_columns_bulk(id, "dbo")`
- **THEN** the entry for `Id` has `base_type: "int"`, `data_type: "int"`, `is_identity: true`, `is_computed: false`, `is_nullable: false`
- **AND** the entry for `FullName` has `data_type: "nvarchar(101)"`, `is_computed: true`, `is_identity: false`, `character_max_length: 101`

#### Scenario: Defaults and extended-property comments are surfaced

- **WHEN** a column `Users.CreatedAt` has type `datetime2(7)`, a default constraint `(SYSUTCDATETIME())`, and an `MS_Description` extended property `"row insertion timestamp"`
- **AND** the user invokes `mssql_list_columns_bulk(id, "dbo")`
- **THEN** the entry for `CreatedAt` has `data_type: "datetime2(7)"`, `column_default: "(SYSUTCDATETIME())"`, and `comment: "row insertion timestamp"`

#### Scenario: Columns with no default or comment carry null

- **WHEN** a column has no default constraint and no `MS_Description` extended property
- **THEN** its entry has `column_default: null` and `comment: null`

#### Scenario: Privileges silently filter inaccessible rows

- **WHEN** the connection login lacks permission to see a particular table in `sys.columns` (catalog visibility filtered by ownership chain)
- **THEN** that table simply does not appear in `columns_by_relation`
- **AND** the command still returns successfully with the visible relations

#### Scenario: Read-only connection succeeds

- **WHEN** the connection is flagged read-only (`ApplicationIntent=ReadOnly` or session-level enforcement) and the user invokes `mssql_list_columns_bulk(id, "dbo")`
- **THEN** the command returns the column payload normally without any write attempt

#### Scenario: Disconnected connection rejected

- **WHEN** the caller invokes `mssql_list_columns_bulk(id, schema)` for a connection id that has no registered pool
- **THEN** the command returns `AppError::NotFound` and does not open a connection

#### Scenario: Total timeout cancels and surfaces a timeout error

- **WHEN** `mssql_list_columns_bulk` is invoked for a schema whose query takes longer than 10 seconds
- **THEN** at 10 seconds the backend issues a server-side cancel for the in-flight query
- **AND** the command returns `AppError::Mssql` with a timeout indication
- **AND** one `argus:activity-log` event is emitted with `kind: "list_columns_bulk"`, `kind_namespace: "mssql"`, `status: "err"`, `metric: null`

#### Scenario: Empty schema returns empty map

- **WHEN** the schema exists but contains no relations
- **THEN** the response is `{ schema, columns_by_relation: {} }`
- **AND** the activity-log entry has `metric: { kind: "items", value: 0 }`

### Requirement: Bulk columns cache and ingestion

The frontend SHALL maintain a process-wide in-memory cache of bulk-fetched MS SQL Server columns keyed by `(connectionId, schema)` within the connected database. The cache MUST be exposed via accessors equivalent to `recordColumnsBulk(connectionId, schema, columns_by_relation)` and `getColumns(connectionId, schema, relation)`. Ingestion of a bulk result MUST replace any existing per-relation column entries for that `(connectionId, schema)` and MUST notify subscribers exactly once per bulk ingestion (not once per relation).

The cache MUST NOT be persisted to disk; it lives only for the process lifetime.

Because an MS SQL Server connection is bound to a single database for its lifetime in v1, the cache key intentionally omits a database component — the `connectionId` already encodes which database is in scope. If a future change introduces an in-session database picker, switching database MUST invalidate the entire cache for that `connectionId`.

The cache MUST be invalidated for a `(connectionId, schema)` slot when **any** of the following occur:

- The `Schema: Refresh` palette command is invoked for that connection.
- The `mssql:active-changed` event reports a disconnect for that connection (drops all `(connectionId, *)` slots).
- A `mssql_apply_table_edits` call against any relation in the schema succeeds (conservative invalidation — DDL might have changed).
- The user activates the SQL editor's `Refresh columns` affordance for that schema.

#### Scenario: Bulk ingestion populates the cache

- **WHEN** the frontend invokes `recordColumnsBulk("conn-1", "dbo", { Users: [{ name: "Id", data_type: "int", base_type: "int", is_nullable: false, is_identity: true, is_computed: false, column_default: null, character_max_length: null, comment: null }, …], Orders: [...] })`
- **THEN** subsequent calls to `getColumns("conn-1", "dbo", "Users")` return the cached column array
- **AND** subscribers are notified exactly once for the bulk ingestion

#### Scenario: Schema refresh invalidates the cache

- **WHEN** the cache contains bulk entries for `("conn-1", "dbo")` and `("conn-1", "sales")`
- **AND** the user runs `Schema: Refresh` for `conn-1`
- **THEN** subsequent `getColumns("conn-1", "dbo", <any>)` returns no cached entry
- **AND** subscribers are notified

#### Scenario: Disconnect invalidates the cache

- **WHEN** the cache holds entries for `conn-1` and `mssql:active-changed` fires reporting `conn-1` disconnected
- **THEN** all `(conn-1, *)` slots are dropped from the cache

#### Scenario: Apply-table-edits invalidates the schema slot

- **WHEN** the cache holds an entry for `("conn-1", "dbo")` and `mssql_apply_table_edits` succeeds against `dbo.Users`
- **THEN** the `("conn-1", "dbo")` slot is invalidated
- **AND** the next autocomplete or pre-warm against `dbo` re-fetches via `mssql_list_columns_bulk`

#### Scenario: No disk persistence

- **WHEN** the cache holds entries and the application process exits and restarts
- **THEN** the cache starts empty; no previous entries are restored from disk

### Requirement: Autocomplete consumer

The SQL editor's column-name completion source SHALL read from this cache. When a user types `schema.table.<TAB>`, the editor MUST suggest columns from the cached payload for that schema's `<table>` entry, if present.

The autocomplete renderer MUST insert column names wrapped in square brackets when the column name is non-bareword (contains spaces, special characters, or matches a MS SQL Server reserved keyword — SQL Server has a larger reserved-word set than MySQL, including identifiers such as `Order`, `User`, `Group`, `Key`, `Plan`, and many more). Plain-identifier columns MAY be inserted bare.

#### Scenario: Cached columns drive table-qualified completion

- **WHEN** the cache holds `("conn-1", "dbo") -> { Users: [{ name: "Id", … }, { name: "Email", … }] }`
- **AND** the user types `dbo.Users.` in the SQL editor and triggers completion
- **THEN** the completion list includes `Id` and `Email` sourced from the cached payload

#### Scenario: Reserved-word column inserted with square brackets

- **WHEN** the cached columns for `dbo.Events` include a column literally named `Order` (a SQL Server reserved word) and a column named `created at` (contains a space)
- **AND** the user accepts each completion
- **THEN** the editor inserts `[Order]` and `[created at]` respectively

#### Scenario: Plain-identifier column inserted bare

- **WHEN** the cached columns include a column `user_id` (matches bareword rules, not reserved)
- **AND** the user accepts the completion
- **THEN** the editor MAY insert `user_id` without square brackets

#### Scenario: Cache miss falls back gracefully

- **WHEN** the user types `dbo.Users.` but the cache holds no entry for `("conn-1", "dbo")`
- **THEN** the editor does not throw and falls back to keywords + document identifiers

### Requirement: Pre-warm on SQL editor open

When a SQL editor tab opens against an MS SQL Server connection, the editor SHALL trigger `mssql_list_columns_bulk` for the user's current default schema (resolved via `SELECT SCHEMA_NAME()`, which returns the connected login's `default_schema_name` — typically `dbo`) if the cache slot for that `(connectionId, schema)` is empty. The pre-warm MUST be:

- **Fire-and-forget** — it MUST NOT block input nor the editor mount.
- **Idempotent** — if the cache slot is already populated OR a bulk for that slot is currently in flight, no additional fetch is dispatched.
- **Origin-tagged** — the IPC call uses `origin: "auto"`.
- **Tolerant of unknown default** — if `SELECT SCHEMA_NAME()` returns `NULL` or an empty string (no resolvable default schema), the pre-warm is skipped entirely.
- **Respectful of `useVisibleSchemas`** — if the user has hidden system schemas (e.g. `sys`, `INFORMATION_SCHEMA`, `db_*`) via the per-connection visible-schemas setting, the pre-warm MUST target the resolved default user schema (typically `dbo`) and MUST NOT pre-warm hidden system schemas even when they would otherwise be the default.

On bulk success, the result MUST be ingested into the cache. On bulk failure, the error MUST be logged via `console.warn` and the cache slot MUST be left empty; the failure MUST NOT be retried automatically (the user can invalidate or use `Refresh columns` to retry).

#### Scenario: Opening a SQL tab pre-warms the default schema

- **WHEN** the user opens a new SQL editor tab against `conn-1` and `SELECT SCHEMA_NAME()` returns `"dbo"`
- **AND** the cache holds no entry for `("conn-1", "dbo")`
- **THEN** within one tick the editor invokes `mssql_list_columns_bulk("conn-1", "dbo", "auto")`
- **AND** on success the cache slot for `("conn-1", "dbo")` is populated

#### Scenario: Pre-warm does not block editor input

- **WHEN** a SQL tab opens and dispatches the pre-warm
- **THEN** the editor accepts keystrokes immediately, before the bulk request resolves

#### Scenario: Pre-warm skipped when cache already populated

- **WHEN** the cache slot for `("conn-1", "dbo")` is already populated and the user opens another SQL tab against `conn-1`
- **THEN** no additional `mssql_list_columns_bulk` IPC is dispatched

#### Scenario: Pre-warm de-duplicated for in-flight slot

- **WHEN** two SQL tabs open against `conn-1` (default schema `dbo`) within the same tick and the cache slot is empty
- **THEN** exactly one `mssql_list_columns_bulk` IPC is dispatched for `("conn-1", "dbo")`

#### Scenario: No default schema skips pre-warm

- **WHEN** the user opens a SQL tab against `conn-1` and `SELECT SCHEMA_NAME()` returns `NULL`
- **THEN** `mssql_list_columns_bulk` is NOT invoked by the pre-warm path
- **AND** the editor still functions; autocomplete will be populated on first explicit schema-qualified completion request

#### Scenario: Hidden system schema is not pre-warmed

- **WHEN** the user has hidden `sys` and `INFORMATION_SCHEMA` via `useVisibleSchemas` and `SELECT SCHEMA_NAME()` resolves to a hidden system schema
- **THEN** the pre-warm targets the user's effective default user schema (typically `dbo`) instead, OR is skipped if no visible user schema is determinable
- **AND** no bulk fetch is dispatched against any hidden system schema

#### Scenario: Pre-warm failure is non-blocking

- **WHEN** the pre-warm bulk returns an error
- **THEN** the editor continues to function normally
- **AND** the cache slot remains empty
- **AND** the autocomplete in the open SQL tab gracefully falls back to keywords + document identifiers
