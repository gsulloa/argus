## MODIFIED Requirements

### Requirement: List objects command

The Postgres module SHALL expose a Tauri command `postgres_list_objects(id, schema)` that returns every browsable object kind in the given schema as a single typed payload `{ schema, tables, views, materialized_views, functions, types, extensions, indexes, triggers }` (snake_case keys, matching the rest of the Postgres module's IPC surface). Tables MUST include regular tables (`relkind = 'r'`), partitioned tables (`'p'`), and foreign tables (`'f'`), each carrying `kind: "regular"|"partitioned"|"foreign"`. Functions MUST include their argument signature so overloads are distinguishable. Indexes and triggers MUST carry their parent table name. The command MUST query `pg_catalog` (not `information_schema`) and MUST execute against a client borrowed from the existing pool registry. Sequences are intentionally excluded from the payload — they are not rendered by V1 of the schema browser, and re-introducing them is the responsibility of a future change that ships a sequence viewer. Internally the command SHOULD fetch the data relkinds (`r`/`p`/`f`/`v`/`m`) with a single UNION-ALL query and SHOULD pipeline the remaining structure queries (functions, types, extensions, indexes, triggers) concurrently on the borrowed client.

#### Scenario: Empty schema returns empty arrays

- **WHEN** the user invokes `postgres.listObjects(id, "empty")` for a schema that exists but contains no objects
- **THEN** the command returns a payload where every collection (tables, views, materialized_views, functions, types, extensions, indexes, triggers) is an empty array

#### Scenario: Mixed-content schema returns each kind in its bucket

- **WHEN** the schema `analytics` contains 1 regular table, 1 partitioned table, 1 view, 1 materialized view, 1 enum type, 1 function, 1 index on the regular table, 1 trigger on the regular table
- **AND** the user invokes `postgres.listObjects(id, "analytics")`
- **THEN** the response has 2 tables (one with `kind: "regular"`, one with `kind: "partitioned"`), 1 view, 1 materialized_view, 1 type with `kind: "enum"`, 1 function with a populated `args_signature`, 1 index whose `table` references the regular table, and 1 trigger whose `table` references the regular table

#### Scenario: Function overloads are distinguishable

- **WHEN** the schema contains two functions named `f`, one with signature `(int)` and one with signature `(text)`
- **THEN** the response includes two function entries, each with the full `args_signature` distinguishing them, and both entries have the same `name`

#### Scenario: Foreign tables surface with foreign kind

- **WHEN** the schema contains a foreign table created via `CREATE FOREIGN TABLE`
- **THEN** the response includes a table entry with `kind: "foreign"`

#### Scenario: Internal triggers are excluded

- **WHEN** the schema contains a constraint trigger that Postgres marks `tgisinternal = true`
- **THEN** the response's `triggers` array does not include that trigger

#### Scenario: Estimated row counts are populated from pg_class

- **WHEN** a regular table has `pg_class.reltuples = 1234567`
- **THEN** the table entry has `estimated_rows: 1234567`; the command MUST NOT issue `SELECT COUNT(*)` to compute it

#### Scenario: Permission-denied on a kind degrades gracefully

- **WHEN** the connection user lacks privilege to read one of the catalog tables backing a kind (e.g. `pg_extension`)
- **THEN** the response still returns; the affected collection is empty; a `tracing::warn!` is emitted on the Rust side; the rest of the kinds are populated normally

#### Scenario: Sequences are not present in the payload

- **WHEN** the schema contains one or more sequences
- **THEN** the returned payload has no `sequences` field, and the sequences are not represented in any other field

### Requirement: Schema tree UI under each active connection

The frontend SHALL render a navigable schema tree directly underneath each active Postgres connection row in the sidebar. The tree MUST consume the platform's `SidebarTree` primitive. Each schema node MUST be expandable to reveal exactly two child groups: `Data` (containing all tables, views, and materialized views in that schema, mixed and ordered alphabetically by name, case-insensitive) and `Structure` (containing all functions, types, and extensions in that schema, mixed and ordered alphabetically by name, case-insensitive). The kind of an item MUST be communicated by a kind-specific icon and, where multiple variants share an icon, a small text badge (for example `partitioned` on partitioned tables, `FDW` on foreign tables). Each table node MUST be further expandable to reveal its indexes and triggers as nested children grouped under `Indexes` and `Triggers` sub-nodes — indexes and triggers MUST NOT appear as top-level items in the `Structure` group. Sequences MUST NOT be rendered in the tree.

#### Scenario: Tree appears on connect, disappears on disconnect

- **WHEN** the user clicks a Postgres connection row to connect, and the connect succeeds
- **THEN** the schema tree appears under that row
- **AND** when the user disconnects the same connection
- **THEN** the schema tree is removed from the sidebar

#### Scenario: Two flat groups under each schema

- **WHEN** the user expands a schema with mixed objects
- **THEN** the immediate children are exactly two group nodes: `Data` (with a count of the data items) and `Structure` (with a count of the structure items)
- **AND** the items inside `Data` are tables, views, and materialized views, mixed and ordered alphabetically by name (case-insensitive)
- **AND** the items inside `Structure` are functions, types, and extensions, mixed and ordered alphabetically by name (case-insensitive)

#### Scenario: Empty group is omitted

- **WHEN** a schema has data items but no structure items (or vice versa)
- **THEN** only the non-empty group node is rendered under the schema

#### Scenario: Table node reveals indexes and triggers as nested children

- **WHEN** the user expands a table node that has indexes and triggers
- **THEN** the table's children are two sub-groups, `Indexes` and `Triggers`, containing the corresponding entries
- **AND** these entries do not appear inside the schema's `Structure` group

#### Scenario: Foreign and partitioned tables carry a badge

- **WHEN** the tree renders a table whose `kind` is `"foreign"` or `"partitioned"`
- **THEN** the table node displays a small text badge (`FDW` or `partitioned` respectively) after the name, while sharing the regular-table icon

#### Scenario: Sequences are absent from the tree

- **WHEN** a schema contains one or more sequences
- **THEN** no node in the rendered tree represents those sequences, anywhere in the tree

## ADDED Requirements

### Requirement: Per-schema load timeout with server-side cancellation

The backend SHALL enforce a 15-second timeout on `postgres_list_objects`. When the timer expires before the work completes, the backend MUST send a cancellation to the Postgres server using the client's cancel token (issuing a real `pg_cancel_backend`-equivalent over a fresh short-lived connection that matches the connection's TLS configuration), MUST then drop the in-flight task, and MUST return `AppError::Postgres { code: Some("57014"), message: ... }` (SQLSTATE 57014 = `query_canceled`). The cancellation request MAY fail (transient network) — that failure MUST NOT prevent the timeout error from being returned to the frontend.

#### Scenario: Long-running list_objects is cancelled at 15 seconds

- **WHEN** `postgres_list_objects` is invoked for a schema whose introspection takes longer than 15 seconds
- **THEN** at 15 seconds the backend issues a server-side cancel for the in-flight query
- **AND** the command returns `AppError::Postgres` with code `"57014"` and a message that names the timeout

#### Scenario: Successful load under the timeout returns normally

- **WHEN** `postgres_list_objects` completes within 15 seconds
- **THEN** the command returns the typed `SchemaObjects` payload as usual

#### Scenario: Cancel-request failure does not mask the timeout error

- **WHEN** the backend times out and the follow-up cancellation request also fails (e.g. the network blip caused both)
- **THEN** the command still returns `AppError::Postgres` with code `"57014"`, and a `tracing::warn!` records the cancel-request failure

### Requirement: Auto-retry on timeout, manual retry otherwise

When the frontend receives `AppError::Postgres` with code `"57014"` from `postgres_list_objects`, it SHALL automatically retry the same call exactly once before surfacing an error state to the user. While the retry is in flight, the schema's row in the tree MUST display a `retrying` indicator distinct from the initial `loading` indicator. If the retry succeeds, the schema renders normally. If the retry also fails (timeout or any other error), or if the original failure was not a timeout, the schema's row MUST render a manually clickable `Retry` affordance whose activation re-runs the load. The frontend MUST NOT auto-retry on errors other than `"57014"`.

#### Scenario: First timeout triggers an automatic retry

- **WHEN** the frontend's first call to `postgres_list_objects` for a schema returns `AppError::Postgres` with code `"57014"`
- **THEN** the schema row displays a `retrying` indicator
- **AND** the frontend re-invokes `postgres_list_objects` for the same schema exactly once, without user action

#### Scenario: Successful retry recovers the schema

- **WHEN** the auto-retry call returns a successful `SchemaObjects` payload
- **THEN** the schema renders its data and structure children normally
- **AND** the `retrying` indicator is removed

#### Scenario: Retry failure surfaces a manual retry

- **WHEN** the auto-retry call also fails (timeout or any other error)
- **THEN** the schema row displays a `Retry` button next to the schema name
- **AND** the schema's children show an error placeholder with the typed error message
- **AND** activating the `Retry` button re-runs the load and re-enters the loading flow

#### Scenario: Non-timeout errors do not auto-retry

- **WHEN** the frontend's first call returns any `AppError` other than `Postgres { code: "57014" }`
- **THEN** the schema row immediately displays the manual `Retry` button (no automatic retry is dispatched)
