## ADDED Requirements

### Requirement: List columns bulk command

The MySQL module SHALL expose a Tauri command `mysql_list_columns_bulk(id, schema, origin?)` that returns column metadata for **every** browsable relation (table or view) in a schema in a single round-trip. The optional `origin` argument MUST be `"user"` or `"auto"`, defaulting to `"auto"` (this command is typically fired in the background to populate the autocomplete cache).

The command MUST:

- Acquire a connection from the existing pool registry, MUST NOT open a new connection.
- Run a single SQL query against `INFORMATION_SCHEMA.COLUMNS` filtered by `TABLE_SCHEMA = ?`, ordered by `TABLE_NAME, ORDINAL_POSITION`.
- Group rows in Rust by `TABLE_NAME` into a `BTreeMap<String, Vec<BulkColumnInfo>>`, preserving `ORDINAL_POSITION` order within each relation.
- Enforce a 10-second total timeout with a server-side cancellation on expiry; on timeout return an `AppError::Mysql` timeout variant.
- Behave identically on read-only connections — this command is a pure read.
- Emit exactly one `argus:activity-log` event before returning, with `kind: "list_columns_bulk"`, `connection_id: <id>`, `origin: <origin argument>`, `sql: null`, `params: null`, `metric: { kind: "items", value: <total columns summed across relations> }` on success (`null` on failure), and `status` matching the result.

The response payload MUST be `{ schema: string, columns_by_relation: { [relation_name]: BulkColumnInfo[] } }` (snake_case keys), where `BulkColumnInfo` is:

```
{
  name: string,
  data_type: string,        // INFORMATION_SCHEMA.COLUMNS.DATA_TYPE
  full_type: string,        // INFORMATION_SCHEMA.COLUMNS.COLUMN_TYPE (e.g. "varchar(255)")
  nullable: boolean,        // IS_NULLABLE = 'YES'
  default: string | null,   // COLUMN_DEFAULT
  comment: string | null,   // COLUMN_COMMENT (null when empty)
}
```

#### Scenario: Schema with mixed relations returns columns grouped per relation

- **WHEN** the schema `analytics` contains tables `events`(3 cols) and `sessions`(4 cols), and view `daily_summary`(2 cols)
- **AND** the user (or background flow) invokes `mysql_list_columns_bulk(id, "analytics")`
- **THEN** the response is `{ schema: "analytics", columns_by_relation: { events: [3 entries], sessions: [4 entries], daily_summary: [2 entries] } }`
- **AND** entries within each relation are ordered by `ORDINAL_POSITION`
- **AND** one `argus:activity-log` event is emitted with `kind: "list_columns_bulk"`, `status: "ok"`, `metric: { kind: "items", value: 9 }`

#### Scenario: Defaults, comments, and full_type are surfaced

- **WHEN** a column `users.created_at` has data type `datetime`, full type `datetime(6)`, default `CURRENT_TIMESTAMP(6)`, and comment `"row insertion timestamp"`
- **AND** the user invokes `mysql_list_columns_bulk(id, "app")`
- **THEN** the entry for `created_at` has `data_type: "datetime"`, `full_type: "datetime(6)"`, `default: "CURRENT_TIMESTAMP(6)"`, and `comment: "row insertion timestamp"`

#### Scenario: Columns with no default or comment carry null

- **WHEN** a column has no default and `COLUMN_COMMENT` is empty
- **THEN** its entry has `default: null` and `comment: null`

#### Scenario: Privileges silently filter inaccessible rows

- **WHEN** the connection user lacks privilege to see a particular table's columns in `INFORMATION_SCHEMA.COLUMNS`
- **THEN** that table simply does not appear in `columns_by_relation`
- **AND** the command still returns successfully with the visible relations

#### Scenario: Read-only connection succeeds

- **WHEN** the connection is flagged read-only and the user invokes `mysql_list_columns_bulk(id, "app")`
- **THEN** the command returns the column payload normally without any write attempt

#### Scenario: Disconnected connection rejected

- **WHEN** the caller invokes `mysql_list_columns_bulk(id, schema)` for a connection id that has no registered pool
- **THEN** the command returns `AppError::NotFound` and does not open a connection

#### Scenario: Total timeout cancels and surfaces a timeout error

- **WHEN** `mysql_list_columns_bulk` is invoked for a schema whose query takes longer than 10 seconds
- **THEN** at 10 seconds the backend issues a server-side cancel for the in-flight query
- **AND** the command returns `AppError::Mysql` with a timeout indication
- **AND** one `argus:activity-log` event is emitted with `kind: "list_columns_bulk"`, `status: "err"`, `metric: null`

#### Scenario: Empty schema returns empty map

- **WHEN** the schema exists but contains no relations
- **THEN** the response is `{ schema, columns_by_relation: {} }`
- **AND** the activity-log entry has `metric: { kind: "items", value: 0 }`

### Requirement: Bulk columns cache and ingestion

The frontend SHALL maintain a process-wide in-memory cache of bulk-fetched MySQL columns keyed by `(connectionId, schema)`. The cache MUST be exposed via accessors equivalent to `recordColumnsBulk(connectionId, schema, columns_by_relation)` and `getColumns(connectionId, schema, relation)`. Ingestion of a bulk result MUST replace any existing per-relation column entries for that `(connectionId, schema)` and MUST notify subscribers exactly once per bulk ingestion (not once per relation).

The cache MUST NOT be persisted to disk; it lives only for the process lifetime.

The cache MUST be invalidated for a `(connectionId, schema)` slot when **any** of the following occur:

- The `Schema: Refresh` palette command is invoked for that connection.
- The `mysql:active-changed` event reports a disconnect for that connection.
- A `mysql_apply_table_edits` call against any relation in the schema succeeds (conservative invalidation — DDL might have changed).
- The user activates the SQL editor's `Refresh columns` affordance for that schema.

#### Scenario: Bulk ingestion populates the cache

- **WHEN** the frontend invokes `recordColumnsBulk("conn-1", "app", { users: [{ name: "id", data_type: "bigint", full_type: "bigint unsigned", nullable: false, default: null, comment: null }, …], orders: [...] })`
- **THEN** subsequent calls to `getColumns("conn-1", "app", "users")` return the cached column array
- **AND** subscribers are notified exactly once for the bulk ingestion

#### Scenario: Schema refresh invalidates the cache

- **WHEN** the cache contains bulk entries for `("conn-1", "app")` and `("conn-1", "analytics")`
- **AND** the user runs `Schema: Refresh` for `conn-1`
- **THEN** subsequent `getColumns("conn-1", "app", <any>)` returns no cached entry
- **AND** subscribers are notified

#### Scenario: Disconnect invalidates the cache

- **WHEN** the cache holds entries for `conn-1` and `mysql:active-changed` fires reporting `conn-1` disconnected
- **THEN** all `(conn-1, *)` slots are dropped from the cache

#### Scenario: Apply-table-edits invalidates the schema slot

- **WHEN** the cache holds an entry for `("conn-1", "app")` and `mysql_apply_table_edits` succeeds against `app.users`
- **THEN** the `("conn-1", "app")` slot is invalidated
- **AND** the next autocomplete or pre-warm against `app` re-fetches via `mysql_list_columns_bulk`

#### Scenario: No disk persistence

- **WHEN** the cache holds entries and the application process exits and restarts
- **THEN** the cache starts empty; no previous entries are restored from disk

### Requirement: Autocomplete consumer

The SQL editor's column-name completion source SHALL read from this cache. When a user types `schema.table.<TAB>`, the editor MUST suggest columns from the cached payload for that schema's `<table>` entry, if present.

The autocomplete renderer MUST insert column names wrapped in backticks when the column name is non-bareword (contains spaces, special characters, or matches a MySQL reserved keyword). Plain-identifier columns MAY be inserted bare.

#### Scenario: Cached columns drive table-qualified completion

- **WHEN** the cache holds `("conn-1", "app") -> { users: [{ name: "id", … }, { name: "email", … }] }`
- **AND** the user types `app.users.` in the SQL editor and triggers completion
- **THEN** the completion list includes `id` and `email` sourced from the cached payload

#### Scenario: Non-bareword column inserted with backticks

- **WHEN** the cached columns for `app.events` include a column literally named `order` (a MySQL reserved word) and a column named `created at` (contains a space)
- **AND** the user accepts each completion
- **THEN** the editor inserts `` `order` `` and `` `created at` `` respectively

#### Scenario: Plain-identifier column inserted bare

- **WHEN** the cached columns include a column `user_id` (matches bareword rules, not reserved)
- **AND** the user accepts the completion
- **THEN** the editor MAY insert `user_id` without backticks

#### Scenario: Cache miss falls back gracefully

- **WHEN** the user types `app.users.` but the cache holds no entry for `("conn-1", "app")`
- **THEN** the editor does not throw and falls back to keywords + document identifiers

### Requirement: Pre-warm on SQL editor open

When a SQL editor tab opens against a MySQL connection, the editor SHALL trigger `mysql_list_columns_bulk` for the user's current default schema (resolved via `SELECT DATABASE()`) if the cache slot for that `(connectionId, schema)` is empty. The pre-warm MUST be:

- **Fire-and-forget** — it MUST NOT block input nor the editor mount.
- **Idempotent** — if the cache slot is already populated OR a bulk for that slot is currently in flight, no additional fetch is dispatched.
- **Origin-tagged** — the IPC call uses `origin: "auto"`.
- **Tolerant of unknown default** — if `SELECT DATABASE()` returns `NULL` (no default schema selected), the pre-warm is skipped entirely.

On bulk success, the result MUST be ingested into the cache. On bulk failure, the error MUST be logged via `console.warn` and the cache slot MUST be left empty; the failure MUST NOT be retried automatically (the user can invalidate or use `Refresh columns` to retry).

#### Scenario: Opening a SQL tab pre-warms the default schema

- **WHEN** the user opens a new SQL editor tab against `conn-1` and `SELECT DATABASE()` returns `"app"`
- **AND** the cache holds no entry for `("conn-1", "app")`
- **THEN** within one tick the editor invokes `mysql_list_columns_bulk("conn-1", "app", "auto")`
- **AND** on success the cache slot for `("conn-1", "app")` is populated

#### Scenario: Pre-warm does not block editor input

- **WHEN** a SQL tab opens and dispatches the pre-warm
- **THEN** the editor accepts keystrokes immediately, before the bulk request resolves

#### Scenario: Pre-warm skipped when cache already populated

- **WHEN** the cache slot for `("conn-1", "app")` is already populated and the user opens another SQL tab against `conn-1`
- **THEN** no additional `mysql_list_columns_bulk` IPC is dispatched

#### Scenario: Pre-warm de-duplicated for in-flight slot

- **WHEN** two SQL tabs open against `conn-1` (default schema `app`) within the same tick and the cache slot is empty
- **THEN** exactly one `mysql_list_columns_bulk` IPC is dispatched for `("conn-1", "app")`

#### Scenario: No default schema skips pre-warm

- **WHEN** the user opens a SQL tab against `conn-1` and `SELECT DATABASE()` returns `NULL`
- **THEN** `mysql_list_columns_bulk` is NOT invoked by the pre-warm path
- **AND** the editor still functions; autocomplete will be populated on first explicit schema-qualified completion request

#### Scenario: Pre-warm failure is non-blocking

- **WHEN** the pre-warm bulk returns an error
- **THEN** the editor continues to function normally
- **AND** the cache slot remains empty
- **AND** the autocomplete in the open SQL tab gracefully falls back to keywords + document identifiers
