## MODIFIED Requirements

### Requirement: List table extras command

The Postgres module SHALL expose a Tauri command `postgres_list_table_extras(id, schema, relation)` that returns indexes and triggers for **one** relation as `{ schema, relation, indexes: Option<Vec<IndexInfo>>, triggers: Option<Vec<TriggerInfo>>, failures: Vec<KindFailure> }`. The command MUST scope its `pg_index` and `pg_trigger` queries to the named relation via `WHERE` clauses on `pg_class.relname` (and `pg_namespace.nspname`). The two queries MUST run concurrently with `tokio::join!` and partial-degradation semantics identical to `postgres_list_structure`: per-query timeout 8 seconds, total timeout 10 seconds, failures collected in the envelope. Internal triggers (`tgisinternal = true`) MUST be excluded.

The command MUST bound **connection acquisition and pre-flight pool lookups** (e.g. `sslmode_for`, `acquire`) with an additional timeout of 3 seconds. If either pre-flight step times out, the command MUST return `AppError::Postgres { code: Some("57014"), message }` and emit a single `argus:activity-log` `err` entry — it MUST NOT proceed to run any catalog query. This ensures the total time from IPC invocation to typed response is bounded even when the connection pool itself is unhealthy.

The command MUST handle malformed catalog rows defensively: row-decoding SHALL use `try_get` (or equivalent) so a NULL or wrong-typed column produces an `Err(AppError)` from the affected sub-query, which the existing `try_kind`/`aggregate_one` machinery then collects into the `failures` envelope. A panic inside the command task MUST NOT be possible from a malformed row.

The command MUST be safe for relation names that are SQL reserved words (e.g. `order`, `select`, `from`). Reserved-word relations MUST be passed through to the queries as parameter values (never interpolated into SQL), and the command MUST return within `TOTAL_TIMEOUT + ACQUIRE_TIMEOUT` for such relations the same as for any other relation.

The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "list_table_extras"`, `connection_id: <id>`, `origin: "auto"`, `sql: null`, `params: null`, `metric: { kind: "items", value: <indexes len + triggers len, None → 0> }` on success (`null` on outer failure), and `status` matching whether the command itself returned `Ok` or `Err`.

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

#### Scenario: Reserved-word relation name resolves normally

- **WHEN** a schema contains a table literally named `order` with 1 index and 1 trigger
- **AND** the user invokes `postgres.listTableExtras(id, schema, "order")`
- **THEN** the response has `indexes: Some([1 entry])`, `triggers: Some([1 entry])`, `failures: []`
- **AND** the command returns within 5 seconds against a local Postgres instance

#### Scenario: Connection acquisition timeout surfaces as 57014

- **WHEN** the underlying pool's `acquire` (or `sslmode_for`) fails to return a client within the connection-acquisition timeout (3 seconds)
- **THEN** the command returns `AppError::Postgres` with code `"57014"` and a message identifying acquisition as the cause
- **AND** no catalog query is executed
- **AND** exactly one `argus:activity-log` event is emitted with `kind: "list_table_extras"`, `status: "err"`, `error.code: "57014"`

#### Scenario: Malformed catalog row surfaces as a kind failure rather than a panic

- **WHEN** a catalog row returned for `pg_index` contains a NULL or unexpected-type value in a column the decoder treats as non-NULL
- **THEN** the command MUST return `Ok(TableExtrasResult { indexes: None, triggers: Some([...]), failures: [{ kind: "indexes", code: None, message: <decode error> }] })`
- **AND** the command task MUST NOT panic; the IPC promise MUST resolve to the typed envelope

### Requirement: Lazy on-expand fetching of structure and table extras

The frontend SHALL fetch a schema's `Structure` group only when the user expands it (via `SidebarTree`'s expand toggle). Until expansion, no `postgres_list_structure` IPC SHALL be issued for that schema. Similarly, the frontend SHALL fetch a table's indexes/triggers only when the user expands that table; no `postgres_list_table_extras` SHALL be issued for collapsed tables. The first expansion MUST trigger the fetch; subsequent expand/collapse cycles MUST serve the cached result without re-fetching.

Every `postgres_list_table_extras` invocation issued by the frontend MUST be guarded by a hard **frontend safety timeout** of 12 seconds. If neither a resolve nor a reject reaches the frontend within that window, the frontend MUST transition the per-table state out of `loading` into a typed `tableExtrasFailed` carrying a synthetic `AppError("Timeout", "Loading table details timed out (12s).")`, exposing the same inline `Retry` affordance used by other failure modes. The safety timeout MUST NOT cancel an in-flight backend query; it only governs the visible UI state. A late-arriving backend response after the safety timeout has fired MUST be ignored (its dispatch MUST be a no-op).

Frontend safety-timeout behavior applies ONLY to `postgres_list_table_extras`. `postgres_list_structure` retains its existing handling.

#### Scenario: Collapsed Structure group never fetches

- **WHEN** the user expands a schema and only views the `Data` group
- **THEN** `postgres_list_structure` is NEVER invoked for that schema

#### Scenario: First Structure expand fetches, second does not

- **WHEN** the user expands the `Structure` group of schema `public` for the first time
- **THEN** `postgres.listStructure(id, "public")` is invoked exactly once
- **AND** when the user collapses and re-expands the same group in the same session
- **THEN** the cached payload is rendered and `postgres.listStructure` is not invoked again

#### Scenario: First table expand triggers per-table extras fetch

- **WHEN** the user expands the table `public.users` for the first time
- **THEN** `postgres.listTableExtras(id, "public", "users")` is invoked exactly once
- **AND** other tables' `Indexes`/`Triggers` are NOT fetched until the user expands them

#### Scenario: Per-table cache is keyed by relation

- **WHEN** the user has expanded `public.users` (causing one `listTableExtras` call)
- **AND** the user expands `public.orders` for the first time
- **THEN** `postgres.listTableExtras` is invoked once more, with `relation: "orders"`
- **AND** re-expanding `public.users` does NOT re-fetch

#### Scenario: Frontend safety timeout flips a stuck spinner into a retry

- **WHEN** the user expands a table and the IPC `listTableExtras` promise neither resolves nor rejects within 12 seconds
- **THEN** the per-table state transitions to `tableExtrasFailed` with a synthetic `AppError("Timeout", …)`
- **AND** the inline `Retry` affordance becomes available
- **AND** the loading spinner is removed

#### Scenario: Late backend response after safety timeout is ignored

- **WHEN** the safety timeout has fired and transitioned the state to `tableExtrasFailed`
- **AND** the backend then returns a successful `TableExtrasResult` 3 seconds later
- **THEN** the late dispatch is a no-op; the failure state is preserved
- **AND** activating `Retry` re-invokes `postgres.listTableExtras` and re-enters the loading flow normally
