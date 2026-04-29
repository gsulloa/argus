## MODIFIED Requirements

### Requirement: List schemas command

The Postgres module SHALL expose a Tauri command `postgres_list_schemas(id)` that returns every schema visible to the connection user as `Array<{ name: string, owner: string, is_system: boolean, comment: string | null }>` (snake_case keys, matching the rest of the Postgres module's IPC surface). A schema MUST be marked `is_system: true` when its name matches `pg_*` or equals `information_schema`. The command MUST acquire a connection from the existing pool registry and MUST NOT open a new connection. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "list_schemas"`, `connection_id: <id>`, `origin: "auto"`, `sql: null`, `params: null`, `metric: { kind: "items", value: <returned schemas length> }` on success (`null` on failure), and `status` matching the result.

#### Scenario: Listing schemas on a fresh connection

- **WHEN** the user invokes `postgres.listSchemas(id)` for an active connection on a database with `public`, `analytics`, `pg_catalog`, `information_schema`
- **THEN** the command returns four entries; `public` and `analytics` have `isSystem: false`; `pg_catalog` and `information_schema` have `isSystem: true`

#### Scenario: Schema comments are surfaced

- **WHEN** the user invokes `postgres.listSchemas(id)` and `analytics` has `COMMENT ON SCHEMA analytics IS 'reporting'`
- **THEN** the entry for `analytics` has `comment: "reporting"`

#### Scenario: Disconnected connection rejected

- **WHEN** the user invokes `postgres.listSchemas(id)` for a connection id that has no registered pool
- **THEN** the command returns `AppError::NotFound` (no pool registered) and does not open a connection

#### Scenario: Successful call emits an activity-log entry

- **WHEN** `postgres.listSchemas(id)` returns 4 schemas
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_schemas"`, `status: "ok"`, `metric: { kind: "items", value: 4 }`, `origin: "auto"`

#### Scenario: Failing call emits an activity-log entry with error

- **WHEN** `postgres.listSchemas(id)` is invoked for a disconnected id
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_schemas"`, `status: "err"`, `metric: null`

### Requirement: List relations command

The Postgres module SHALL expose a Tauri command `postgres_list_relations(id, schema)` that returns every browsable relation in the given schema as a single typed payload `{ schema, tables, views, materialized_views }` (snake_case keys). Tables MUST include regular tables (`relkind = 'r'`), partitioned tables (`'p'`), and foreign tables (`'f'`), each carrying `kind: "regular"|"partitioned"|"foreign"`. The command MUST query `pg_catalog` (not `information_schema`), MUST execute against a client borrowed from the existing pool registry, and MUST run a single UNION-ALL-style query over `pg_class` filtered by relkind. The command MUST enforce a 10-second total timeout and on expiry MUST issue a `pg_cancel_backend`-equivalent cancellation, drop the in-flight task, and return `AppError::Postgres { code: Some("57014"), message }`. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "list_relations"`, `connection_id: <id>`, `origin: "auto"`, `sql: null`, `params: null`, `metric: { kind: "items", value: <tables + views + materialized_views lengths> }` on success (`null` on failure), and `status` matching the result.

#### Scenario: Empty schema returns empty arrays

- **WHEN** the user invokes `postgres.listRelations(id, "empty")` for a schema that exists but contains no relations
- **THEN** the command returns a payload where `tables`, `views`, and `materialized_views` are empty arrays

#### Scenario: Mixed-content schema returns each relation kind in its bucket

- **WHEN** the schema `analytics` contains 1 regular table, 1 partitioned table, 1 view, 1 materialized view
- **AND** the user invokes `postgres.listRelations(id, "analytics")`
- **THEN** the response has 2 tables (one with `kind: "regular"`, one with `kind: "partitioned"`), 1 view, 1 materialized_view

#### Scenario: Estimated row counts are populated from pg_class

- **WHEN** a regular table has `pg_class.reltuples = 1234567`
- **THEN** the table entry has `estimated_rows: 1234567`; the command MUST NOT issue `SELECT COUNT(*)` to compute it

#### Scenario: Foreign tables surface with foreign kind

- **WHEN** the schema contains a foreign table created via `CREATE FOREIGN TABLE`
- **THEN** the response includes a table entry with `kind: "foreign"`

#### Scenario: Disconnected connection rejected

- **WHEN** the user invokes `postgres.listRelations(id, schema)` for a connection id that has no registered pool
- **THEN** the command returns `AppError::NotFound` and does not open a connection

#### Scenario: Total timeout cancels and surfaces 57014

- **WHEN** `postgres.listRelations` is invoked for a schema whose query takes longer than 10 seconds
- **THEN** at 10 seconds the backend issues a server-side cancel for the in-flight query
- **AND** the command returns `AppError::Postgres` with code `"57014"`

#### Scenario: Successful call emits an activity-log entry

- **WHEN** `postgres.listRelations` returns 3 tables, 2 views, 0 materialized views
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_relations"`, `status: "ok"`, `metric: { kind: "items", value: 5 }`, `origin: "auto"`

#### Scenario: Timeout failure emits an activity-log entry with code

- **WHEN** `postgres.listRelations` times out
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_relations"`, `status: "err"`, `error.code: "57014"`

### Requirement: List structure command with partial-degradation

The Postgres module SHALL expose a Tauri command `postgres_list_structure(id, schema)` that returns the schema's non-relation objects as `{ schema, functions: Option<Vec<FunctionInfo>>, types: Option<Vec<TypeInfo>>, extensions: Option<Vec<ExtensionInfo>>, failures: Vec<KindFailure> }`. The command MUST run the three queries concurrently with `tokio::join!` (NOT `try_join!`), each with a per-query timeout of 8 seconds, and a total command timeout of 10 seconds. When a sub-query fails or times out, the corresponding payload field MUST be `None` and a `KindFailure { kind, code, message }` MUST be appended to `failures` — the other sub-queries MUST still surface their results. Permission-denied (SQLSTATE 42501) on a sub-query MUST degrade to `Some(Vec::new())` with a `tracing::warn!` (not a failure entry), preserving today's behavior. Function entries MUST include `name`, `oid`, `language`, and `comment` but MUST NOT include `args_signature` or `return_type` — those are resolved on demand via `postgres_get_function_signature`. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "list_structure"`, `connection_id: <id>`, `origin: "auto"`, `sql: null`, `params: null`, and `metric: { kind: "items", value: <sum of lengths of Some(...) buckets, treating None as 0> }` on success (`null` on outer failure). `status` is `"ok"` whenever the command itself returns `Ok(...)`, even if `failures` is non-empty.

#### Scenario: All sub-queries succeed

- **WHEN** the user invokes `postgres.listStructure(id, "public")` and all three sub-queries succeed
- **THEN** `functions`, `types`, and `extensions` are each `Some(...)` populated with results
- **AND** `failures` is an empty array

#### Scenario: One sub-query times out, others succeed

- **WHEN** the schema's `pg_proc` query exceeds the 8-second per-query timeout
- **AND** `pg_type` and `pg_extension` queries complete in under 1 second
- **THEN** the response has `functions: None`, `types: Some([...])`, `extensions: Some([...])`
- **AND** `failures` contains exactly one entry: `{ kind: "functions", code: "57014", message: "..." }`

#### Scenario: Permission-denied on a kind degrades to empty without entering failures

- **WHEN** the connection user lacks privilege to read `pg_extension` (SQLSTATE 42501)
- **THEN** the response has `extensions: Some([])`
- **AND** `failures` does not include an entry for `extensions`
- **AND** a `tracing::warn!` is emitted on the Rust side

#### Scenario: Function entries omit signature

- **WHEN** the user invokes `postgres.listStructure` and the schema contains a function `f`
- **THEN** the function entry contains `name`, `oid`, `language`, `comment` but NOT `args_signature` or `return_type`

#### Scenario: Total timeout cancels remaining work

- **WHEN** the total command timeout (10s) expires before all sub-queries finish
- **THEN** the backend issues `pg_cancel_backend` and drops the client
- **AND** sub-queries that had not yet completed appear in `failures` with code `"57014"`

#### Scenario: All-success call emits an activity-log entry

- **WHEN** `postgres.listStructure` returns 4 functions, 2 types, 1 extension, no failures
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_structure"`, `status: "ok"`, `metric: { kind: "items", value: 7 }`, `origin: "auto"`

#### Scenario: Partial-failure call still emits ok with smaller item count

- **WHEN** `postgres.listStructure` returns `functions: None`, `types: Some(2)`, `extensions: Some(1)`, with one failure entry
- **THEN** one `argus:activity-log` event is emitted with `status: "ok"` and `metric: { kind: "items", value: 3 }`

### Requirement: List table extras command

The Postgres module SHALL expose a Tauri command `postgres_list_table_extras(id, schema, relation)` that returns indexes and triggers for **one** relation as `{ schema, relation, indexes: Option<Vec<IndexInfo>>, triggers: Option<Vec<TriggerInfo>>, failures: Vec<KindFailure> }`. The command MUST scope its `pg_index` and `pg_trigger` queries to the named relation via `WHERE` clauses on `pg_class.relname` (and `pg_namespace.nspname`). The two queries MUST run concurrently with `tokio::join!` and partial-degradation semantics identical to `postgres_list_structure`: per-query timeout 8 seconds, total timeout 10 seconds, failures collected in the envelope. Internal triggers (`tgisinternal = true`) MUST be excluded. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "list_table_extras"`, `connection_id: <id>`, `origin: "auto"`, `sql: null`, `params: null`, `metric: { kind: "items", value: <indexes len + triggers len, None → 0> }` on success (`null` on outer failure), and `status` matching whether the command itself returned `Ok` or `Err`.

#### Scenario: Both queries succeed for a table with indexes and triggers

- **WHEN** the table `analytics.events` has 3 indexes and 2 triggers
- **AND** the user invokes `postgres.listTableExtras(id, "analytics", "events")`
- **THEN** the response has `indexes: Some([3 entries])` and `triggers: Some([2 entries])`
- **AND** `failures` is empty

#### Scenario: Per-table scoping excludes other tables' indexes

- **WHEN** schema `public` contains tables `users` (3 indexes) and `orders` (5 indexes)
- **AND** the user invokes `postgres.listTableExtras(id, "public", "users")`
- **THEN** the response includes only the 3 indexes belonging to `users`

#### Scenario: Internal triggers are excluded

- **WHEN** the table has a constraint trigger that Postgres marks `tgisinternal = true`
- **THEN** the response's `triggers` array does not include that trigger

#### Scenario: One sub-query fails, the other surfaces

- **WHEN** the `pg_index` query times out at 8 seconds but `pg_trigger` succeeds in 200ms
- **THEN** the response has `indexes: None`, `triggers: Some([...])`
- **AND** `failures` contains `{ kind: "indexes", code: "57014", message: "..." }`

#### Scenario: Successful call emits an activity-log entry

- **WHEN** `postgres.listTableExtras` returns 3 indexes and 2 triggers
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_table_extras"`, `status: "ok"`, `metric: { kind: "items", value: 5 }`, `origin: "auto"`
