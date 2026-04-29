## ADDED Requirements

### Requirement: List columns bulk command

The Postgres module SHALL expose a Tauri command `postgres_list_columns_bulk(connection_id, schema, origin?)` that returns column metadata for **every** browsable relation in a schema in a single round-trip. The optional `origin` argument MUST be `"user"` or `"auto"`, defaulting to `"auto"` (this command is typically fired in the background to populate the autocomplete cache).

The command MUST:

- Acquire a connection from the existing pool registry, MUST NOT open a new connection.
- Run a single SQL query that joins `pg_attribute`, `pg_class`, `pg_namespace`, `pg_attrdef` (default values), and `pg_description` (comments), filtered by `nspname = $1`, `relkind IN ('r','v','m','p','f')`, `attnum > 0`, `NOT attisdropped`.
- Group rows in Rust by `relname` into a `BTreeMap<String, Vec<BulkColumnInfo>>`, preserving `attnum` order within each relation.
- Enforce a 8-second total timeout with a `pg_cancel_backend`-equivalent cancellation on expiry; on timeout return `AppError::Postgres { code: Some("57014"), message }`.
- Emit exactly one `argus:activity-log` event before returning, with `kind: "list_columns_bulk"`, `connection_id: <id>`, `origin: <origin argument>`, `sql: null`, `params: null`, `metric: { kind: "items", value: <total columns across all relations> }` on success (`null` on failure), and `status` matching the result.

The response payload MUST be `{ schema: string, columns_by_relation: { [relation_name]: BulkColumnInfo[] } }` (snake_case keys), where `BulkColumnInfo` is:

```
{
  name: string,
  data_type: string,        // pg_catalog.format_type
  ordinal_position: i32,
  is_nullable: boolean,
  default_value: string | null,
  comment: string | null,
}
```

#### Scenario: Schema with mixed relations returns columns grouped per relation

- **WHEN** the schema `analytics` contains tables `events`(3 cols) and `sessions`(4 cols), and view `daily_summary`(2 cols)
- **AND** the user (or background flow) invokes `postgres.listColumnsBulk(id, "analytics")`
- **THEN** the response is `{ schema: "analytics", columns_by_relation: { events: [3 entries], sessions: [4 entries], daily_summary: [2 entries] } }`
- **AND** entries within each relation are ordered by `ordinal_position`
- **AND** one `argus:activity-log` event is emitted with `kind: "list_columns_bulk"`, `status: "ok"`, `metric: { kind: "items", value: 9 }`

#### Scenario: Default values and comments are surfaced

- **WHEN** a column `users.created_at` has default `now()` and a comment `"row insertion timestamp"`
- **AND** the user invokes `postgres.listColumnsBulk(id, "public")`
- **THEN** the entry for `created_at` has `default_value: "now()"` and `comment: "row insertion timestamp"`

#### Scenario: Columns with no default or comment carry null

- **WHEN** a column has no default and no comment
- **THEN** its entry has `default_value: null` and `comment: null`

#### Scenario: Disconnected connection rejected

- **WHEN** the caller invokes `postgres.listColumnsBulk(id, schema)` for a connection id that has no registered pool
- **THEN** the command returns `AppError::NotFound` and does not open a connection

#### Scenario: Total timeout cancels and surfaces 57014

- **WHEN** `postgres.listColumnsBulk` is invoked for a schema whose query takes longer than 8 seconds
- **THEN** at 8 seconds the backend issues a server-side cancel for the in-flight query
- **AND** the command returns `AppError::Postgres` with code `"57014"`
- **AND** one `argus:activity-log` event is emitted with `kind: "list_columns_bulk"`, `status: "err"`, `error.code: "57014"`, `metric: null`

#### Scenario: Empty schema returns empty map

- **WHEN** the schema exists but contains no relations
- **THEN** the response is `{ schema, columns_by_relation: {} }`
- **AND** the activity-log entry has `metric: { kind: "items", value: 0 }`

### Requirement: Bulk columns cache and ingestion

The frontend SHALL maintain a process-wide cache of bulk-fetched columns keyed by `(connectionId, schema)`, exposed via `globalSchemaCache.recordColumnsBulk(connectionId, schema, columnsByRelation)` and `globalSchemaCache.getColumns(connectionId, schema, relation)`. Ingestion of a bulk result MUST replace any existing per-relation column entries for that `(connectionId, schema)` and MUST notify subscribers exactly once per bulk ingestion (not once per relation).

The cache MUST also expose `globalSchemaCache.getNamespace(connectionId): SQLNamespace` that derives a `lang-sql`-compatible namespace structure from the cached columns. The namespace MUST:

- Include only schemas that have at least one cached relation with at least one column.
- Exclude system schemas (`information_schema` and any schema whose name starts with `pg_`) regardless of cache content.
- Map each `(schema, relation)` to a list of `Completion` objects with `{ label: column_name, type: "property", detail: data_type, info: comment ?? undefined }`.

The cache MUST be invalidated for a connection when the connection's `globalSchemaCache.invalidate(connectionId)` is called (already triggered by disconnect and `Schema: Refresh`).

#### Scenario: Bulk ingestion populates the namespace

- **WHEN** the frontend invokes `recordColumnsBulk("conn-1", "public", { users: [{name: "id", data_type: "bigint", …}, …], orders: [...] })`
- **THEN** subsequent calls to `getColumns("conn-1", "public", "users")` return the cached column array
- **AND** `getNamespace("conn-1")` includes a `public` key mapping `users` and `orders` to `Completion[]` arrays
- **AND** subscribers are notified exactly once for the bulk ingestion

#### Scenario: System schemas excluded from namespace

- **WHEN** the cache contains entries for `pg_catalog` and `information_schema` (e.g. from prior fetches by viewer flows)
- **THEN** `getNamespace(connectionId)` does NOT include keys `pg_catalog` or `information_schema`

#### Scenario: Cache invalidation drops bulk entries

- **WHEN** the cache contains bulk entries for `("conn-1", "public")` and `("conn-1", "analytics")`
- **AND** the user runs `Schema: Refresh` for `conn-1`, which calls `globalSchemaCache.invalidate("conn-1")`
- **THEN** subsequent `getNamespace("conn-1")` returns an empty namespace
- **AND** subscribers are notified

### Requirement: Background trigger on schema relations load

The schema browser (`useSchemaTree`) SHALL fire a background `postgres_list_columns_bulk` request for a schema once after that schema's `postgres_list_relations` succeeds. The fetch MUST be:

- **Fire-and-forget** — it MUST NOT block the relations load nor any UI interaction.
- **Idempotent** — if the bulk has already succeeded for that `(connectionId, schema)` (cache populated) OR is currently in flight, no additional fetch is dispatched.
- **Origin-tagged** — the IPC call uses `origin: "auto"`.
- **Skipped for system schemas** — schemas where the name is `information_schema` or starts with `pg_` MUST NOT trigger a bulk.

On bulk success, the result MUST be ingested via `globalSchemaCache.recordColumnsBulk`. On bulk failure, the error MUST be logged via `console.warn` and the cache MUST be left empty for that schema; the failure MUST NOT be retried automatically (the user can invalidate to retry).

#### Scenario: Successful relations load triggers bulk in background

- **WHEN** the user makes schema `public` visible for the first time and `postgres.listRelations(id, "public")` returns successfully
- **THEN** within one tick the frontend invokes `postgres.listColumnsBulk(id, "public", "auto")`
- **AND** when that bulk returns successfully, the namespace for `id` includes `public` with all its relations and columns

#### Scenario: System schemas do not trigger a bulk

- **WHEN** the user makes schema `pg_catalog` visible and `postgres.listRelations` succeeds
- **THEN** `postgres.listColumnsBulk` is NOT invoked

#### Scenario: Idempotent under repeated relations loads

- **WHEN** the schema's relations are loaded successfully and the bulk returns successfully
- **AND** the schema is hidden from the visible schemas filter and re-shown in the same session
- **THEN** the bulk is NOT re-fetched (the cache hit short-circuits)

#### Scenario: In-flight bulk de-duplicated

- **WHEN** two different code paths attempt to trigger the bulk for the same `(connectionId, schema)` within a short window before the first request has completed
- **THEN** exactly one `postgres.listColumnsBulk` IPC is dispatched

#### Scenario: Failure is non-blocking

- **WHEN** the bulk fetch returns `AppError::Postgres` with code `"57014"` (timeout)
- **THEN** the schema browser continues to function normally (relations remain visible, table viewers open, etc.)
- **AND** the namespace for that schema remains empty
- **AND** the autocomplete in any open query tab gracefully falls back to keywords + document identifiers
