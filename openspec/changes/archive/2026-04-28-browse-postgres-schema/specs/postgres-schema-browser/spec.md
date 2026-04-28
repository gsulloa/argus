## ADDED Requirements

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

### Requirement: List objects command

The Postgres module SHALL expose a Tauri command `postgres_list_objects(id, schema)` that returns every browsable object kind in the given schema as a single typed payload `{ schema, tables, views, materialized_views, functions, sequences, types, extensions, indexes, triggers }` (snake_case keys, matching the rest of the Postgres module's IPC surface). Tables MUST include regular tables (`relkind = 'r'`), partitioned tables (`'p'`), and foreign tables (`'f'`), each carrying `kind: "regular"|"partitioned"|"foreign"`. Functions MUST include their argument signature so overloads are distinguishable. Indexes and triggers MUST carry their parent table name. The command MUST query `pg_catalog` (not `information_schema`) and MUST execute against a client borrowed from the existing pool registry.

#### Scenario: Empty schema returns empty arrays

- **WHEN** the user invokes `postgres.listObjects(id, "empty")` for a schema that exists but contains no objects
- **THEN** the command returns a payload where every collection (tables, views, …) is an empty array

#### Scenario: Mixed-content schema returns each kind in its bucket

- **WHEN** the schema `analytics` contains 1 regular table, 1 partitioned table, 1 view, 1 materialized view, 1 sequence, 1 enum type, 1 function, 1 index on the regular table, 1 trigger on the regular table
- **AND** the user invokes `postgres.listObjects(id, "analytics")`
- **THEN** the response has 2 tables (one with `kind: "regular"`, one with `kind: "partitioned"`), 1 view, 1 materializedView, 1 sequence, 1 type with `kind: "enum"`, 1 function with a populated `argsSignature`, 1 index whose `table` references the regular table, and 1 trigger whose `table` references the regular table

#### Scenario: Function overloads are distinguishable

- **WHEN** the schema contains two functions named `f`, one with signature `(int)` and one with signature `(text)`
- **THEN** the response includes two function entries, each with the full `argsSignature` distinguishing them, and both entries have the same `name`

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

### Requirement: Schema cache and invalidation

The frontend SHALL cache `SchemaObjects` payloads in memory keyed by `(connectionId, schema)`. The cache MUST be populated on first expand of a schema and MUST be served on subsequent expands without re-fetching. The cache MUST be invalidated when (a) the user invokes `Schema: Refresh` from the palette or the connection row's refresh button, or (b) a `postgres:active-changed` event reports the connection as no longer active. The cache MUST NOT be persisted to disk.

#### Scenario: First expand fetches; second expand does not

- **WHEN** the user expands schema `public` for the first time in a session
- **THEN** the command `postgres.listObjects(id, "public")` is invoked exactly once
- **AND** when the user collapses and re-expands the same schema in the same session
- **THEN** the cached payload is rendered and `postgres.listObjects` is not invoked again

#### Scenario: Refresh palette command clears the connection's cache

- **WHEN** the user runs `Schema: Refresh` from the palette while focused on a connection
- **THEN** every cached entry for that connection is dropped
- **AND** the next expand of any schema in that connection re-invokes `postgres.listObjects`

#### Scenario: Disconnect drops the cache

- **WHEN** the user disconnects a connection
- **THEN** every cached entry for that connection id is dropped
- **AND** if the user reconnects and re-expands a schema, `postgres.listObjects` is invoked

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

The frontend SHALL render a navigable schema tree directly underneath each active Postgres connection row in the sidebar. The tree MUST consume the platform's `SidebarTree` primitive. Each schema node MUST be expandable to reveal its objects grouped by kind (Tables, Views, Materialized Views, Functions, Sequences, Types, Extensions). Each table node MUST be further expandable to reveal its indexes and triggers as children. Nodes MUST display a kind-specific icon and may display a small badge (for example "FDW" on foreign tables, "RO" on a connection's read-only state).

#### Scenario: Tree appears on connect, disappears on disconnect

- **WHEN** the user clicks a Postgres connection row to connect, and the connect succeeds
- **THEN** the schema tree appears under that row
- **AND** when the user disconnects the same connection
- **THEN** the schema tree is removed from the sidebar

#### Scenario: Group nodes group objects by kind

- **WHEN** the user expands a schema with mixed objects
- **THEN** the immediate children are kind groups (Tables, Views, …) with item counts
- **AND** expanding "Tables" reveals each table by name in alphabetical order

#### Scenario: Table node reveals indexes and triggers as children

- **WHEN** the user expands a table that has indexes and triggers
- **THEN** the table's children are two groups, "Indexes" and "Triggers", containing the corresponding entries

#### Scenario: Foreign table badge

- **WHEN** the tree renders a table whose `kind` is `"foreign"`
- **THEN** the table node displays a small "FDW" badge after the name

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
