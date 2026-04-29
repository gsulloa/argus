# postgres-schema-browser Specification

## Purpose
TBD - created by archiving change browse-postgres-schema. Update Purpose after archive.
## Requirements
### Requirement: List schemas command

The Postgres module SHALL expose a Tauri command `postgres_list_schemas(id)` that returns every schema visible to the connection user as `Array<{ name: string, owner: string, is_system: boolean, comment: string | null }>` (snake_case keys, matching the rest of the Postgres module's IPC surface). A schema MUST be marked `is_system: true` when its name matches `pg_*` or equals `information_schema`. The command MUST acquire a connection from the existing pool registry and MUST NOT open a new connection.

#### Scenario: Listing schemas on a fresh connection

- **WHEN** the user invokes `postgres.listSchemas(id)` for an active connection on a database with `public`, `analytics`, `pg_catalog`, `information_schema`
- **THEN** the command returns four entries; `public` and `analytics` have `isSystem: false`; `pg_catalog` and `information_schema` have `isSystem: true`

#### Scenario: Schema comments are surfaced

- **WHEN** the user invokes `postgres.listSchemas(id)` and `analytics` has `COMMENT ON SCHEMA analytics IS 'reporting'`
- **THEN** the entry for `analytics` has `comment: "reporting"`

#### Scenario: Disconnected connection rejected

- **WHEN** the user invokes `postgres.listSchemas(id)` for a connection id that has no registered pool
- **THEN** the command returns `AppError::NotFound` (no pool registered) and does not open a connection

### Requirement: Schema cache and invalidation

The frontend SHALL cache schema-browser data in memory keyed by `(connectionId, schema)` with sub-keys for each lazy group. The per-schema cache MUST hold three independent slots: `relations` (eager), `structure` (lazy), and a `Map<relation, tableExtras>` (lazy per-table). Each slot MUST be populated on first need and MUST be served on subsequent reads without re-fetching. The cache MUST be invalidated for an entire connection when (a) the user invokes `Schema: Refresh` from the palette or the connection row's refresh button, or (b) a `postgres:active-changed` event reports the connection as no longer active. Individual group slots MAY be invalidated independently when the user activates an inline retry button on a failed group. The cache MUST NOT be persisted to disk.

#### Scenario: First relations expand fetches; second does not

- **WHEN** the user makes schema `public` visible for the first time in a session
- **THEN** the command `postgres.listRelations(id, "public")` is invoked exactly once
- **AND** when the schema is hidden via the picker and re-shown in the same session
- **THEN** the cached payload is rendered and `postgres.listRelations` is not invoked again

#### Scenario: Group cache slots are independent

- **WHEN** the `relations` slot has loaded successfully and the `structure` slot is in error state
- **AND** the user activates the inline retry button on the `structure` group
- **THEN** only `postgres.listStructure` is re-invoked; the relations slot is not touched

#### Scenario: Refresh palette command clears the connection's full cache

- **WHEN** the user runs `Schema: Refresh` from the palette while focused on a connection
- **THEN** every cached entry for that connection is dropped — `relations`, `structure`, and per-table `tableExtras` for every schema
- **AND** the next visibility/expand of any group re-invokes the corresponding command

#### Scenario: Disconnect drops the cache

- **WHEN** the user disconnects a connection
- **THEN** every cached entry for that connection id is dropped
- **AND** if the user reconnects and re-views a schema, the relevant commands are invoked

### Requirement: Visible schemas filter

The Postgres module SHALL persist a per-connection setting `pgVisibleSchemas:<connectionId>` containing a JSON array of schema names. When the setting is unset, the schema tree MUST default to showing all non-system schemas (system schemas remain available behind a "Show system schemas" toggle in the picker). When the setting is set, the tree MUST render only the listed schemas in the order returned by `postgres.listSchemas`. Toggling a schema in the picker MUST persist immediately and update the tree on the next render.

#### Scenario: Default visibility hides system schemas

- **WHEN** the user opens a connection for the first time and has no `pgVisibleSchemas:<id>` setting
- **THEN** the tree renders every schema returned by `listSchemas` for which `isSystem === false`
- **AND** schemas with `isSystem === true` are not rendered until "Show system schemas" is toggled in the picker

#### Scenario: Picker selection persists per connection

- **WHEN** the user opens the picker, unchecks `analytics`, and closes the picker
- **THEN** `analytics` is removed from the tree
- **AND** the `pgVisibleSchemas:<id>` setting reflects the new selection
- **AND** the next time the user opens the same connection in a future app session, `analytics` remains hidden

#### Scenario: Selection is per connection

- **WHEN** the user has hidden `analytics` for connection A
- **AND** the user opens connection B which also has an `analytics` schema
- **THEN** connection B's tree shows `analytics` (default behavior; A's setting does not leak to B)

### Requirement: Schema tree UI under each active connection

The frontend SHALL render a navigable schema tree directly underneath each active Postgres connection row in the sidebar. The tree MUST consume the platform's `SidebarTree` primitive. Each schema node MUST be expandable to reveal exactly two child groups: `Data` (containing all tables, views, and materialized views in that schema, mixed and ordered alphabetically by name, case-insensitive) and `Structure` (containing all functions, types, and extensions in that schema, mixed and ordered alphabetically by name, case-insensitive). The `Data` group's contents come from the eager `postgres_list_relations` fetch; the `Structure` group's contents come from a lazy `postgres_list_structure` fetch triggered on first expansion of that group. The kind of an item MUST be communicated by a kind-specific icon and, where multiple variants share an icon, a small text badge (for example `partitioned` on partitioned tables, `FDW` on foreign tables). Each table node MUST be further expandable to reveal its indexes and triggers as nested children grouped under `Indexes` and `Triggers` sub-nodes — those sub-groups' contents come from a lazy `postgres_list_table_extras` fetch triggered on first expansion of the parent table. Indexes and triggers MUST NOT appear as top-level items in the `Structure` group. Sequences MUST NOT be rendered in the tree. Function nodes MUST display the function `name` only (no signature inline); when multiple functions share a name in the same schema, the tree MUST visually distinguish them (badge, suffix, or sub-grouping — implementation choice).

#### Scenario: Tree appears on connect, disappears on disconnect

- **WHEN** the user clicks a Postgres connection row to connect, and the connect succeeds
- **THEN** the schema tree appears under that row
- **AND** when the user disconnects the same connection
- **THEN** the schema tree is removed from the sidebar

#### Scenario: Two flat groups under each schema, lazy Structure

- **WHEN** the user expands a schema with mixed objects
- **THEN** the immediate children are exactly two group nodes: `Data` (loaded eagerly, with a count of items) and `Structure` (lazy — initially shown as a placeholder "(expand to load)" until the user expands it)
- **AND** when the user expands the `Structure` group
- **THEN** the lazy fetch fires, the placeholder shows "Loading…", and on success the items render mixed and ordered alphabetically by name (case-insensitive)

#### Scenario: Empty group is omitted

- **WHEN** the loaded payload for a group has zero items
- **THEN** that group node is not rendered (or rendered with an "(empty)" indicator — implementation choice)

#### Scenario: Table node lazy-loads indexes and triggers on expand

- **WHEN** the user expands a table node for the first time
- **THEN** `postgres_list_table_extras(id, schema, relation)` is invoked
- **AND** until the response arrives, the table's children show a "Loading…" placeholder
- **AND** on success, the table's children are two sub-groups, `Indexes` and `Triggers`, containing the corresponding entries

#### Scenario: Foreign and partitioned tables carry a badge

- **WHEN** the tree renders a table whose `kind` is `"foreign"` or `"partitioned"`
- **THEN** the table node displays a small text badge (`FDW` or `partitioned` respectively) after the name, while sharing the regular-table icon

#### Scenario: Sequences are absent from the tree

- **WHEN** a schema contains one or more sequences
- **THEN** no node in the rendered tree represents those sequences, anywhere in the tree

#### Scenario: Function overloads are visually distinguishable

- **WHEN** the schema contains two functions named `f`, one with signature `(int)` and one with signature `(text)`
- **THEN** the tree renders both function nodes
- **AND** the user can visually tell them apart (badge, suffix, or sub-grouping)
- **AND** activating either node opens its own tab (the OID disambiguates)

#### Scenario: Failed group renders inline error with retry

- **WHEN** the lazy `postgres_list_structure` fetch fails entirely (e.g. connection lost)
- **THEN** the `Structure` group renders a placeholder "Failed to load. (Retry)"
- **AND** the `Data` group renders normally with its tables/views
- **AND** activating the inline `Retry` re-invokes `postgres_list_structure` for that schema only

#### Scenario: Partial failure renders surviving kinds with per-kind retry

- **WHEN** `postgres_list_structure` returns `{ functions: null, types: [...], extensions: [...], failures: [{ kind: "functions", ... }] }`
- **THEN** the `Structure` group renders types and extensions normally
- **AND** an inline placeholder "Functions failed (Retry)" appears in place of the functions
- **AND** activating the per-kind `Retry` re-invokes `postgres_list_structure` (re-running all three sub-queries; the cache is replaced on success)

### Requirement: Schema search

Each connection's tree SHALL provide a search input that filters loaded objects by case-insensitive substring match against `<schema>.<name>`. Matching nodes MUST remain visible; non-matching leaf nodes MUST be hidden; ancestor nodes whose subtree contains a match MUST be auto-expanded; the matched substring within each node label MUST be visually highlighted. Search MUST NOT trigger network fetches — it operates only on already-loaded data. The Esc key MUST clear the search.

#### Scenario: Substring filters loaded objects

- **WHEN** the user has expanded the `public` schema (loading its objects) and types `user` in the search box
- **THEN** every node in `public` whose name contains the substring `user` (case-insensitive) remains visible; non-matching leaf nodes are hidden; the `public` schema and matching kind groups are auto-expanded

#### Scenario: Esc clears search

- **WHEN** the user has an active search and presses Esc with the search input focused
- **THEN** the search input clears and the tree returns to its pre-search state

#### Scenario: Search does not trigger fetches

- **WHEN** the user types into the search box and there exist schemas in the tree that have not yet been expanded
- **THEN** no `postgres.listObjects` calls are dispatched
- **AND** the empty-result UI mentions that N schemas have not been loaded yet

#### Scenario: Match count indicator

- **WHEN** the user has an active search returning 7 visible matches across 42 loaded objects
- **THEN** the search input shows an inline indicator "7 of 42"

### Requirement: Activating a node opens an object placeholder tab

The frontend SHALL respond to node activation (Enter key, single click, or double click — equivalent in V1) on any object node by opening or focusing a center-area tab of kind `postgres-object-placeholder`. The tab's payload MUST carry `{ connectionId, schema, kind, name }` plus any kind-specific identifiers (such as a function's full signature). Activation on group nodes (Tables, Views, …) MUST NOT open a tab; it MUST only toggle expansion.

#### Scenario: Click a table opens a placeholder tab

- **WHEN** the user activates a table node `analytics.events`
- **THEN** a center-area tab of kind `postgres-object-placeholder` opens with payload `{ connectionId: <id>, schema: "analytics", kind: "table", name: "events" }`
- **AND** the tab's body shows a placeholder text identifying the object and stating that the viewer is not implemented yet

#### Scenario: Activating the same node twice focuses the existing tab

- **WHEN** the user activates the same table node a second time
- **THEN** the existing tab is focused; a new tab is not opened

#### Scenario: Group node activation does not open a tab

- **WHEN** the user activates the "Tables" group node
- **THEN** the group toggles expansion; no tab is opened

### Requirement: Palette commands for schema browsing

The Postgres module SHALL register the following commands in the `command-palette` registry on app start: `Schema: Refresh` (drops the schema cache for the focused connection and re-fetches schemas) and `Schema: Filter Visible…` (opens the visible-schemas picker for the focused connection). When no connection is focused, both commands MUST transition the palette to a connection chooser.

#### Scenario: Refresh on focused connection clears its cache

- **WHEN** the user has a connection focused and runs `Schema: Refresh`
- **THEN** the cache for that connection is dropped, `postgres.listSchemas` is re-invoked, and the tree re-renders with the new result

#### Scenario: Filter Visible opens the picker

- **WHEN** the user has a connection focused and runs `Schema: Filter Visible…`
- **THEN** the visible-schemas picker for that connection opens

#### Scenario: Commands without a focused connection show a chooser

- **WHEN** the user runs `Schema: Refresh` with no sidebar connection focused
- **THEN** the palette transitions to a chooser listing connected Postgres connections; selecting one runs the refresh

### Requirement: Auto-retry on timeout, manual retry otherwise

When the frontend receives `AppError::Postgres` with code `"57014"` from `postgres_list_relations`, it SHALL automatically retry the same call exactly once before surfacing an error state to the user. While the retry is in flight, the schema's `Data` group MUST display a `retrying` indicator distinct from the initial `loading` indicator. If the retry succeeds, the `Data` group renders normally. If the retry also fails, or if the original failure was not a timeout, the `Data` group MUST render a manually clickable `Retry` affordance whose activation re-runs the load.

The frontend MUST NOT auto-retry `postgres_list_structure`, `postgres_list_table_extras`, or `postgres_get_function_signature` — for those commands, any error (timeout or otherwise) MUST surface immediately with a manual retry control. The frontend MUST NOT auto-retry on errors other than `"57014"` for any command.

#### Scenario: First relations timeout triggers an automatic retry

- **WHEN** the frontend's first call to `postgres_list_relations` for a schema returns `AppError::Postgres` with code `"57014"`
- **THEN** the schema's `Data` group displays a `retrying` indicator
- **AND** the frontend re-invokes `postgres_list_relations` for the same schema exactly once, without user action

#### Scenario: Successful relations retry recovers the data group

- **WHEN** the auto-retry call returns a successful payload
- **THEN** the `Data` group renders its tables/views/matviews normally
- **AND** the `retrying` indicator is removed

#### Scenario: Relations retry failure surfaces a manual retry on the data group

- **WHEN** the auto-retry call also fails (timeout or any other error)
- **THEN** the `Data` group displays a `Retry` button
- **AND** the group's children show an error placeholder with the typed error message
- **AND** activating the `Retry` button re-runs the load and re-enters the loading flow

#### Scenario: Lazy structure fetch never auto-retries

- **WHEN** the first call to `postgres_list_structure` for a schema returns `AppError::Postgres` with code `"57014"`
- **THEN** the `Structure` group immediately displays a `Retry` button (no automatic retry)
- **AND** activating the `Retry` button re-runs the load

#### Scenario: Lazy table extras fetch never auto-retries

- **WHEN** the first call to `postgres_list_table_extras` for a table returns any error
- **THEN** the table's children display a `Retry` button (no automatic retry)
- **AND** activating it re-invokes `postgres_list_table_extras` for that single relation

#### Scenario: Non-timeout errors do not auto-retry

- **WHEN** any command's first call returns an `AppError` other than `Postgres { code: "57014" }`
- **THEN** the corresponding group immediately displays the manual `Retry` button (no automatic retry is dispatched)

### Requirement: List relations command

The Postgres module SHALL expose a Tauri command `postgres_list_relations(id, schema)` that returns every browsable relation in the given schema as a single typed payload `{ schema, tables, views, materialized_views }` (snake_case keys). Tables MUST include regular tables (`relkind = 'r'`), partitioned tables (`'p'`), and foreign tables (`'f'`), each carrying `kind: "regular"|"partitioned"|"foreign"`. The command MUST query `pg_catalog` (not `information_schema`), MUST execute against a client borrowed from the existing pool registry, and MUST run a single UNION-ALL-style query over `pg_class` filtered by relkind. The command MUST enforce a 10-second total timeout and on expiry MUST issue a `pg_cancel_backend`-equivalent cancellation, drop the in-flight task, and return `AppError::Postgres { code: Some("57014"), message }`.

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

### Requirement: List structure command with partial-degradation

The Postgres module SHALL expose a Tauri command `postgres_list_structure(id, schema)` that returns the schema's non-relation objects as `{ schema, functions: Option<Vec<FunctionInfo>>, types: Option<Vec<TypeInfo>>, extensions: Option<Vec<ExtensionInfo>>, failures: Vec<KindFailure> }`. The command MUST run the three queries concurrently with `tokio::join!` (NOT `try_join!`), each with a per-query timeout of 8 seconds, and a total command timeout of 10 seconds. When a sub-query fails or times out, the corresponding payload field MUST be `None` and a `KindFailure { kind, code, message }` MUST be appended to `failures` — the other sub-queries MUST still surface their results. Permission-denied (SQLSTATE 42501) on a sub-query MUST degrade to `Some(Vec::new())` with a `tracing::warn!` (not a failure entry), preserving today's behavior. Function entries MUST include `name`, `oid`, `language`, and `comment` but MUST NOT include `args_signature` or `return_type` — those are resolved on demand via `postgres_get_function_signature`.

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

### Requirement: List table extras command

The Postgres module SHALL expose a Tauri command `postgres_list_table_extras(id, schema, relation)` that returns indexes and triggers for **one** relation as `{ schema, relation, indexes: Option<Vec<IndexInfo>>, triggers: Option<Vec<TriggerInfo>>, failures: Vec<KindFailure> }`. The command MUST scope its `pg_index` and `pg_trigger` queries to the named relation via `WHERE` clauses on `pg_class.relname` (and `pg_namespace.nspname`). The two queries MUST run concurrently with `tokio::join!` and partial-degradation semantics identical to `postgres_list_structure`: per-query timeout 8 seconds, total timeout 10 seconds, failures collected in the envelope. Internal triggers (`tgisinternal = true`) MUST be excluded.

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

### Requirement: Get function signature command

The Postgres module SHALL expose a Tauri command `postgres_get_function_signature(id, schema, function_name, oid)` that returns `{ args_signature: string, return_type: string }` for a single function identified by its OID. The command MUST execute `pg_get_function_arguments(oid)` and `pg_get_function_result(oid)` against the given OID and MUST verify the OID belongs to a function in the named schema with the given name (defense in depth: the OID alone is enough, but the schema/name pair guards against UI staleness leading to wrong-target queries). The command MUST enforce a 5-second timeout. Frontend SHALL invoke this lazily — on hover/tooltip of a function node or on activation of a function tab — never proactively for the whole list.

#### Scenario: Returns signature for a known overloaded function

- **WHEN** schema `public` has functions `f(int)` (oid 100001) and `f(text)` (oid 100002)
- **AND** the user invokes `postgres.getFunctionSignature(id, "public", "f", 100002)`
- **THEN** the response is `{ args_signature: "text", return_type: "..." }`

#### Scenario: Mismatched OID/schema/name pair is rejected

- **WHEN** the user invokes `postgres.getFunctionSignature` with an OID that does not exist in the named schema with the given name
- **THEN** the command returns `AppError::NotFound`

#### Scenario: Timeout returns 57014

- **WHEN** the catalog lookup exceeds 5 seconds
- **THEN** the command returns `AppError::Postgres` with code `"57014"`

### Requirement: Partial-result envelope contract

Multi-query commands (`postgres_list_structure`, `postgres_list_table_extras`) SHALL return a partial-result envelope where each kind field is `Option<T>` (`None` indicates that kind's sub-query failed) and a `failures: Vec<KindFailure>` collects per-kind failure details. The envelope MUST be serialized to the frontend via `snake_case` JSON keys: `{ "functions": null, "types": [...], "failures": [...] }`. A `KindFailure` MUST contain `kind: string`, `code: Option<string>` (SQLSTATE if Postgres-typed), `message: string`. Permission-denied (42501) MUST NOT enter `failures` — it degrades to an empty payload silently with logging.

#### Scenario: All-success envelope has empty failures

- **WHEN** every sub-query of a multi-query command returns successfully
- **THEN** `failures` is an empty array

#### Scenario: Failure envelope is consumable by frontend

- **WHEN** the response includes `{ "functions": null, "failures": [{ "kind": "functions", "code": "57014", "message": "timed out (8s)" }] }`
- **THEN** the frontend MUST be able to render the structure group with types/extensions populated and a per-kind error indicator next to "Functions"

### Requirement: Lazy on-expand fetching of structure and table extras

The frontend SHALL fetch a schema's `Structure` group only when the user expands it (via `SidebarTree`'s expand toggle). Until expansion, no `postgres_list_structure` IPC SHALL be issued for that schema. Similarly, the frontend SHALL fetch a table's indexes/triggers only when the user expands that table; no `postgres_list_table_extras` SHALL be issued for collapsed tables. The first expansion MUST trigger the fetch; subsequent expand/collapse cycles MUST serve the cached result without re-fetching.

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

