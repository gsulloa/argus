# mssql-schema-browser Specification

## Purpose
TBD - created by archiving change add-mssql-support. Update Purpose after archive.
## Requirements
### Requirement: List schemas command

The MS SQL Server module SHALL expose a Tauri command `mssql_list_schemas(id)` that returns every schema visible to the connection user within the connected database as `Array<{ name: string, owner: string, is_system: boolean }>` (snake_case keys, matching the rest of the MS SQL Server module's IPC surface). Unlike MySQL, SQL Server distinguishes _database_ (top-level container, bound at connect time) from _schema_ (namespace within a database, e.g. `dbo`, `sales`); this command lists the in-database schemas only, not databases. The underlying query MUST source rows from `sys.schemas` (preferred over `INFORMATION_SCHEMA.SCHEMATA` because `sys.schemas` exposes `principal_id` to filter system-owned schemas). The `owner` field MUST be populated from the schema's owning principal (resolved via `JOIN sys.database_principals ON sys.schemas.principal_id = sys.database_principals.principal_id`). A schema MUST be marked `is_system: true` when its name matches one of `sys`, `INFORMATION_SCHEMA`, `db_owner`, `db_accessadmin`, `db_securityadmin`, `db_ddladmin`, `db_backupoperator`, `db_datareader`, `db_datawriter`, `db_denydatareader`, `db_denydatawriter`, or `guest`. Results MUST be ordered alphabetically by `name`, case-insensitive. The command MUST acquire a connection from the existing pool registry and MUST NOT open a new connection. The command MUST enforce a 10-second total timeout. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "list_schemas"`, `kind_namespace: "mssql"`, `connection_id: <id>`, `origin: "auto"`, `sql: null`, `params: null`, `metric: { kind: "items", value: <returned schemas length> }` on success (`null` on failure), and `status` matching the result.

#### Scenario: Listing schemas on a fresh connection

- **WHEN** the user invokes `mssql.listSchemas(id)` for an active connection on a database with user schemas `app`, `sales`, plus system schemas `dbo`, `sys`, `INFORMATION_SCHEMA`, `db_owner`, `guest`
- **THEN** the command returns seven entries; `app` and `sales` have `is_system: false`; `sys`, `INFORMATION_SCHEMA`, `db_owner`, and `guest` have `is_system: true`; `dbo` has `is_system: false` (the canonical default user schema in SQL Server is NOT considered a system schema)

#### Scenario: Schema owner is surfaced

- **WHEN** the user invokes `mssql.listSchemas(id)` and the schema `sales` is owned by the principal `sales_admin`
- **THEN** the entry for `sales` has `owner: "sales_admin"`

#### Scenario: Alphabetical case-insensitive ordering

- **WHEN** the database contains schemas `Zebra`, `apple`, `Mango`
- **AND** the user invokes `mssql.listSchemas(id)`
- **THEN** the returned array is ordered `apple`, `Mango`, `Zebra` (case-insensitive ascending)

#### Scenario: Disconnected connection rejected

- **WHEN** the user invokes `mssql.listSchemas(id)` for a connection id that has no registered pool
- **THEN** the command returns `AppError::NotFound` (no pool registered) and does not open a connection

#### Scenario: Successful call emits an activity-log entry

- **WHEN** `mssql.listSchemas(id)` returns 7 schemas
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_schemas"`, `kind_namespace: "mssql"`, `status: "ok"`, `metric: { kind: "items", value: 7 }`, `origin: "auto"`

#### Scenario: Failing call emits an activity-log entry with error

- **WHEN** `mssql.listSchemas(id)` is invoked for a disconnected id
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_schemas"`, `kind_namespace: "mssql"`, `status: "err"`, `metric: null`

### Requirement: Database picker above the schema tree

The frontend SHALL render a one-line database picker above the schema tree for each active MS SQL Server connection in the sidebar. The picker MUST display the name of the currently connected database (bound at connect time in v1) and MUST offer a dropdown listing all databases the connection's user can access. The dropdown contents MUST be sourced from `SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name` invoked lazily on first picker open. In v1, the database is bound at connect time and the picker is presentation-only (selecting a different database opens a confirm dialog explaining that v1 binds the database at connect time and offering to open the connection form pre-populated with the new database name as a follow-up). A runtime database switcher is explicitly deferred to a follow-up change.

#### Scenario: Picker shows the current database

- **WHEN** a MS SQL Server connection is connected to database `MyApp`
- **THEN** the picker above the schema tree displays `MyApp` as the current selection

#### Scenario: Dropdown lists accessible databases lazily

- **WHEN** the user opens the database picker dropdown for the first time
- **THEN** `SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1` is invoked exactly once
- **AND** the dropdown renders the resulting list ordered alphabetically
- **AND** subsequent dropdown opens in the same session do not re-fetch

#### Scenario: Selecting a different database in v1 opens a guided follow-up

- **WHEN** the user selects a different database `Reporting` from the dropdown
- **THEN** a confirm dialog explains that v1 binds the database at connect time
- **AND** offers a button to open the connection form pre-populated with `Reporting` as the database field
- **AND** the active connection is NOT modified in-place

#### Scenario: Picker is hidden on disconnected connections

- **WHEN** a MS SQL Server connection is disconnected
- **THEN** the database picker is not rendered

### Requirement: Frontend tree label for MS SQL Server

The frontend SHALL render the top-level in-database grouping label as "Schemas" (not "Databases") for any MS SQL Server connection row in the sidebar, picker dialogs, and palette commands that display a noun for the grouping. The visibility-filter setting key remains `mssqlVisibleSchemas:<connectionId>`. This is a deliberate dialect difference vs. MySQL: SQL Server has both database (top-level) and schema (in-database namespace), and a connection is bound to one database, so the tree under the connection lists schemas — not databases.

#### Scenario: Sidebar visibility picker label

- **WHEN** the user opens the visibility picker for a MS SQL Server connection
- **THEN** the picker title reads "Schemas" (not "Databases")
- **AND** the underlying setting key is `mssqlVisibleSchemas:<connectionId>`

#### Scenario: Palette command labels keep "Schema" terminology

- **WHEN** the user opens the command palette while focused on a MS SQL Server connection
- **THEN** the palette surfaces `Schema: Refresh` and `Schema: Filter Visible…` (internal naming aligns with the noun used on screen)

### Requirement: Schema cache and invalidation

The frontend SHALL cache schema-browser data in a **process-wide** store keyed by `(connectionId, schema)` with sub-keys for each lazy group. The per-schema cache MUST hold three independent slots: `relations` (eager), `structure` (lazy), and a `Map<relation, tableExtras>` (lazy per-table). Each slot MUST be populated on first need and MUST be served on subsequent reads without re-fetching.

The cache MUST survive unmount/remount of the connection's subtree. On mount, `useSchemaTree` MUST seed its local state machine from the process-wide cache: if a non-stale schemas entry exists for the connection, the tree MUST initialize to a loaded state (and seed any cached `relations` slots as loaded) **without** issuing `mssql.listSchemas` or `mssql.listRelations`. Switching focus away from and back to a connection MUST NOT, by itself, drop the cache or trigger a refetch.

Each connection's schemas-level cache entry MUST record a `fetchedAt` timestamp. An entry is **stale** when it is older than the TTL (`SCHEMA_CACHE_TTL_MS`, 1 hour). When a connection is mounted (e.g. refocused) and its entry is stale, the tree MUST render the cached data immediately and refresh in the background (`mssql.listSchemas` followed by eager `mssql.listRelations` for visible schemas); on success the cache is replaced and the tree re-renders; on failure the stale data is retained.

The cache MUST be invalidated for an entire connection when (a) the user invokes `Schema: Refresh` from the palette, the connection row's refresh button, or the global `Cmd+R` / `Ctrl+R` accelerator while the connection is focused, or (b) a `mssql:active-changed` event reports the connection as no longer active. Individual group slots MAY be invalidated independently when the user activates an inline retry button on a failed group. The cache MUST NOT be persisted to disk.

#### Scenario: First relations expand fetches; second does not

- **WHEN** the user makes schema `app` visible for the first time in a session
- **THEN** the command `mssql.listRelations(id, "app")` is invoked exactly once
- **AND** when the schema is hidden via the picker and re-shown in the same session
- **THEN** the cached payload is rendered and `mssql.listRelations` is not invoked again

#### Scenario: Group cache slots are independent

- **WHEN** the `relations` slot has loaded successfully and the `structure` slot is in error state
- **AND** the user activates the inline retry button on the `structure` group
- **THEN** only `mssql.listStructure` is re-invoked; the relations slot is not touched

#### Scenario: Refocusing a loaded connection serves cache without refetch

- **WHEN** a connection's schemas (and visible-schema relations) have loaded and the user switches focus to another connection in the rail and then back within the TTL window
- **THEN** the schema tree renders immediately from the cache
- **AND** neither `mssql.listSchemas` nor `mssql.listRelations` is invoked again on the refocus

#### Scenario: Stale entry past TTL refreshes in the background

- **WHEN** the user refocuses a connection whose cached schemas entry is older than `SCHEMA_CACHE_TTL_MS`
- **THEN** the tree renders the stale cached data immediately
- **AND** `mssql.listSchemas` is re-invoked in the background and the tree re-renders on success without an intervening blank/loading state

#### Scenario: Refresh palette command clears the connection's full cache

- **WHEN** the user runs `Schema: Refresh` from the palette while focused on a connection
- **THEN** every cached entry for that connection is dropped — `relations`, `structure`, and per-table `tableExtras` for every schema
- **AND** the next visibility/expand of any group re-invokes the corresponding command

#### Scenario: Disconnect drops the cache

- **WHEN** the user disconnects a connection
- **THEN** every cached entry for that connection id is dropped
- **AND** if the user reconnects and re-views a schema, the relevant commands are invoked

### Requirement: Visible schemas filter

The MS SQL Server module SHALL persist a per-connection setting `mssqlVisibleSchemas:<connectionId>` containing a JSON array of schema names. When the setting is unset, the schema tree MUST default to showing all non-system schemas (system schemas remain available behind a "Show system schemas" toggle in the picker). When the setting is set, the tree MUST render only the listed schemas in the order returned by `mssql.listSchemas`. Toggling a schema in the picker MUST persist immediately and update the tree on the next render.

#### Scenario: Default visibility hides system schemas

- **WHEN** the user opens a connection for the first time and has no `mssqlVisibleSchemas:<id>` setting
- **THEN** the tree renders every schema returned by `listSchemas` for which `is_system === false`
- **AND** schemas with `is_system === true` are not rendered until "Show system schemas" is toggled in the picker

#### Scenario: Picker selection persists per connection

- **WHEN** the user opens the picker, unchecks `sales`, and closes the picker
- **THEN** `sales` is removed from the tree
- **AND** the `mssqlVisibleSchemas:<id>` setting reflects the new selection
- **AND** the next time the user opens the same connection in a future app session, `sales` remains hidden

#### Scenario: Selection is per connection

- **WHEN** the user has hidden `sales` for connection A
- **AND** the user opens connection B which also has a `sales` schema
- **THEN** connection B's tree shows `sales` (default behavior; A's setting does not leak to B)

### Requirement: Schema tree UI under each active connection

The frontend SHALL render a navigable schema tree directly underneath each active MS SQL Server connection row in the sidebar (below the database picker described above). The tree MUST consume the platform's `SidebarTree` primitive. Each schema node MUST be expandable to reveal exactly two child groups: `Data` (containing all tables and views in that schema, mixed and ordered alphabetically by name, case-insensitive) and `Structure` (containing all procedures, functions, triggers, and sequences in that schema, mixed and ordered alphabetically by name, case-insensitive). The `Data` group's contents come from the eager `mssql_list_relations` fetch; the `Structure` group's contents come from a lazy `mssql_list_structure` fetch triggered on first expansion of that group. The kind of an item MUST be communicated by a kind-specific icon and, where multiple variants share an icon, a small text badge (for example `partitioned` on partitioned tables, `indexed` on indexed views). Each table node MUST be further expandable to reveal its indexes, triggers, foreign keys, check constraints, and default constraints as nested children grouped under `Indexes`, `Triggers`, `Foreign Keys`, `Check Constraints`, and `Default Constraints` sub-nodes — those sub-groups' contents come from a lazy `mssql_list_table_extras` fetch triggered on first expansion of the parent table. Indexes, triggers, foreign keys, check constraints, and default constraints MUST NOT appear as top-level items in the `Structure` group. Procedure nodes MUST display the procedure `name`; function nodes MUST display the function `name` followed by a small text badge indicating the function kind (`SCALAR_FUNCTION` for `FN`, `INLINE_TABLE_VALUED_FUNCTION` for `IF`, `TABLE_VALUED_FUNCTION` for `TF`, `CLR_SCALAR_FUNCTION` for `FS`, `CLR_TABLE_VALUED_FUNCTION` for `FT`). Because MS SQL Server does NOT support routine overloading (a procedure or function name is unique within a schema), no name-disambiguation rule applies.

#### Scenario: Tree appears on connect, disappears on disconnect

- **WHEN** the user clicks a MS SQL Server connection row to connect, and the connect succeeds
- **THEN** the schema tree appears under that row (with the database picker above it)
- **AND** when the user disconnects the same connection
- **THEN** the schema tree and the database picker are removed from the sidebar

#### Scenario: Two flat groups under each schema, lazy Structure

- **WHEN** the user expands a schema with mixed objects
- **THEN** the immediate children are exactly two group nodes: `Data` (loaded eagerly, with a count of items) and `Structure` (lazy — initially shown as a placeholder "(expand to load)" until the user expands it)
- **AND** when the user expands the `Structure` group
- **THEN** the lazy fetch fires, the placeholder shows "Loading…", and on success the items render mixed and ordered alphabetically by name (case-insensitive)

#### Scenario: Empty group is omitted

- **WHEN** the loaded payload for a group has zero items
- **THEN** that group node is not rendered (or rendered with an "(empty)" indicator — implementation choice)

#### Scenario: Table node lazy-loads extras on expand

- **WHEN** the user expands a table node for the first time
- **THEN** `mssql_list_table_extras(id, schema, relation)` is invoked
- **AND** until the response arrives, the table's children show a "Loading…" placeholder
- **AND** on success, the table's children are up to five sub-groups, `Indexes`, `Triggers`, `Foreign Keys`, `Check Constraints`, and `Default Constraints`, containing the corresponding entries

#### Scenario: Partitioned tables carry a badge

- **WHEN** the tree renders a table whose `kind` is `"partitioned"`
- **THEN** the table node displays a small text badge `partitioned` after the name, while sharing the regular-table icon

#### Scenario: Indexed views carry a badge

- **WHEN** the tree renders a view with `is_indexed: true`
- **THEN** the view node displays a small text badge `indexed` after the name, while sharing the regular-view icon
- **AND** indexed views appear in the `Data` group alongside other views, NOT in a separate bucket

#### Scenario: Function kind badge

- **WHEN** the `Structure` group contains a scalar function `current_user_id` (`FN`) and an inline table-valued function `users_for_org` (`IF`)
- **THEN** the tree renders both nodes
- **AND** the scalar function node displays a `SCALAR_FUNCTION` badge after the name
- **AND** the inline TVF node displays an `INLINE_TABLE_VALUED_FUNCTION` badge after the name

#### Scenario: Failed group renders inline error with retry

- **WHEN** the lazy `mssql_list_structure` fetch fails entirely (e.g. connection lost)
- **THEN** the `Structure` group renders a placeholder "Failed to load. (Retry)"
- **AND** the `Data` group renders normally with its tables/views
- **AND** activating the inline `Retry` re-invokes `mssql_list_structure` for that schema only

#### Scenario: Partial failure renders surviving kinds with per-kind retry

- **WHEN** `mssql_list_structure` returns `{ procedures: null, functions: [...], triggers: [...], sequences: [...], failures: [{ kind: "procedures", ... }] }`
- **THEN** the `Structure` group renders functions, triggers, and sequences normally
- **AND** an inline placeholder "Procedures failed (Retry)" appears in place of the procedures
- **AND** activating the per-kind `Retry` re-invokes `mssql_list_structure` (re-running all four sub-queries; the cache is replaced on success)

### Requirement: Schema search

Each connection's tree SHALL provide a search input that filters loaded objects by case-insensitive substring match against `<schema>.<name>`. Matching nodes MUST remain visible; non-matching leaf nodes MUST be hidden; ancestor nodes whose subtree contains a match MUST be auto-expanded; the matched substring within each node label MUST be visually highlighted. Search MUST NOT trigger network fetches — it operates only on already-loaded data. The Esc key MUST clear the search.

#### Scenario: Substring filters loaded objects

- **WHEN** the user has expanded the `app` schema (loading its objects) and types `user` in the search box
- **THEN** every node in `app` whose name contains the substring `user` (case-insensitive) remains visible; non-matching leaf nodes are hidden; the `app` schema and matching kind groups are auto-expanded

#### Scenario: Esc clears search

- **WHEN** the user has an active search and presses Esc with the search input focused
- **THEN** the search input clears and the tree returns to its pre-search state

#### Scenario: Search does not trigger fetches

- **WHEN** the user types into the search box and there exist schemas in the tree that have not yet been expanded
- **THEN** no `mssql.listRelations` calls are dispatched
- **AND** the empty-result UI mentions that N schemas have not been loaded yet

#### Scenario: Match count indicator

- **WHEN** the user has an active search returning 7 visible matches across 42 loaded objects
- **THEN** the search input shows an inline indicator "7 of 42"

### Requirement: Activating a node opens an object placeholder tab

The frontend SHALL respond to node activation (Enter key, single click, or double click — equivalent in V1) on any object node by opening or focusing a center-area tab. Activation on a table or view node MUST open or focus a tab of kind `mssql-table-data` (defined by the `mssql-data-grid` capability) with payload `{ connectionId, connectionName, schema, relation, relationKind: "table" | "view" }` and stable id `mstbl:<connectionId>:<schema>:<relation>`. Activation on any other object kind (procedure, function, trigger, sequence, index, foreign key, check constraint, default constraint) MUST open or focus a tab of kind `mssql-object-placeholder` with payload `{ connectionId, schema, kind, name }` plus any kind-specific identifiers (such as a function's kind discriminator `"SCALAR_FUNCTION" | "INLINE_TABLE_VALUED_FUNCTION" | "TABLE_VALUED_FUNCTION" | "CLR_SCALAR_FUNCTION" | "CLR_TABLE_VALUED_FUNCTION"`) and the existing stable id pattern. Activation on group nodes (Data, Structure, Indexes, Triggers, Foreign Keys, Check Constraints, Default Constraints) MUST NOT open a tab; it MUST only toggle expansion.

#### Scenario: Click a table opens the data viewer tab

- **WHEN** the user activates a table node `sales.orders`
- **THEN** a center-area tab of kind `mssql-table-data` opens with payload `{ connectionId, connectionName, schema: "sales", relation: "orders", relationKind: "table" }`
- **AND** the placeholder tab is NOT opened

#### Scenario: Click a view opens the data viewer tab

- **WHEN** the user activates a view node
- **THEN** the same `mssql-table-data` tab opens with `relationKind: "view"`

#### Scenario: Click a procedure opens the placeholder tab

- **WHEN** the user activates a procedure node
- **THEN** a center-area tab of kind `mssql-object-placeholder` opens with payload `{ connectionId, schema, kind: "procedure", name }`
- **AND** the tab's body shows a placeholder text identifying the object and stating that the viewer is not implemented yet

#### Scenario: Click a function opens the placeholder tab with its kind discriminator

- **WHEN** the user activates a scalar function node `app.current_user_id`
- **THEN** a center-area tab of kind `mssql-object-placeholder` opens with payload `{ connectionId, schema: "app", kind: "function", name: "current_user_id", functionKind: "SCALAR_FUNCTION" }`

#### Scenario: Click a trigger, sequence, index, foreign key, check constraint, or default constraint opens the placeholder tab

- **WHEN** the user activates a trigger, sequence, index, foreign key, check constraint, or default constraint node
- **THEN** a center-area tab of kind `mssql-object-placeholder` opens with the corresponding payload

#### Scenario: Activating the same node twice focuses the existing tab

- **WHEN** the user activates the same object node a second time (regardless of whether it routes to `mssql-table-data` or `mssql-object-placeholder`)
- **THEN** the existing tab is focused; a new tab is not opened

#### Scenario: Group node activation does not open a tab

- **WHEN** the user activates the "Data", "Structure", "Indexes", "Triggers", "Foreign Keys", "Check Constraints", or "Default Constraints" group node
- **THEN** the group toggles expansion; no tab is opened

### Requirement: Palette commands for schema browsing

The MS SQL Server module SHALL register the following commands in the `command-palette` registry on app start: `Schema: Refresh` (drops the schema cache for the focused connection and re-fetches schemas), `Schema: Filter Visible…` (opens the visible-schemas picker for the focused connection), `SQL: New Query` (opens a new `mssql-query` tab against the focused connection), and `SQL: New Query Here` (opens a new `mssql-query` tab pre-populated with SQL contextual to the focused sidebar node). When no connection is focused, all four commands MUST transition the palette to a connection chooser.

`SQL: New Query` MUST always open with an empty SQL buffer. `SQL: New Query Here` MUST pre-populate the buffer based on the focused node. All generated SQL MUST use MS SQL Server identifier quoting — square brackets (`[ ]`), never backticks and never double-quotes (double-quotes are only valid under `QUOTED_IDENTIFIER ON`, which is the default but not guaranteed; square brackets are universal). Embedded `]` characters MUST be escaped by doubling (`a]b` → `[a]]b]`):

- Connection focused → empty buffer (equivalent to `SQL: New Query`).
- Schema focused → `-- schema: [<schema>]\n\n` (a comment header; MS SQL Server's `USE [db]` switches database, not schema, so emitting `USE` for a schema context would be wrong — a comment header is the dialect-correct equivalent).
- Table or view focused → `SELECT TOP 100 * FROM [<schema>].[<relation>];` (`TOP 100` is the SQL Server idiom; `LIMIT` is not supported syntax in SQL Server).
- Any other node kind (procedure, function, trigger, sequence, index, foreign key, check constraint, default constraint) → empty buffer with the connection set to the focused node's connection.

#### Scenario: Refresh on focused connection clears its cache

- **WHEN** the user has a connection focused and runs `Schema: Refresh`
- **THEN** the cache for that connection is dropped, `mssql.listSchemas` is re-invoked, and the tree re-renders with the new result

#### Scenario: Filter Visible opens the picker

- **WHEN** the user has a connection focused and runs `Schema: Filter Visible…`
- **THEN** the visible-schemas picker for that connection opens

#### Scenario: Commands without a focused connection show a chooser

- **WHEN** the user runs `Schema: Refresh` with no sidebar connection focused
- **THEN** the palette transitions to a chooser listing connected MS SQL Server connections; selecting one runs the refresh

#### Scenario: New Query opens a fresh empty query tab

- **WHEN** the user has a connection focused and runs `SQL: New Query`
- **THEN** a new `mssql-query` tab opens against that connection with an empty SQL buffer

#### Scenario: New Query Here on a table pre-populates a TOP 100 SELECT with square brackets

- **WHEN** the user has the table `sales.orders` focused in the sidebar and runs `SQL: New Query Here`
- **THEN** a new `mssql-query` tab opens with SQL `SELECT TOP 100 * FROM [sales].[orders];`
- **AND** the cursor lands at the end of the document so the user can immediately edit or run

#### Scenario: New Query Here on a schema emits a comment header

- **WHEN** the user has the schema `sales` focused and runs `SQL: New Query Here`
- **THEN** a new `mssql-query` tab opens with SQL `-- schema: [sales]` followed by two newlines
- **AND** no `USE` statement is emitted (since `USE` switches database, not schema, in SQL Server)

#### Scenario: Identifier with embedded right-bracket is escaped

- **WHEN** the user has the table `app.weird]name` focused and runs `SQL: New Query Here`
- **THEN** the emitted SQL is `SELECT TOP 100 * FROM [app].[weird]]name];`

#### Scenario: New Query without a focused connection prompts a chooser

- **WHEN** the user runs `SQL: New Query` with no sidebar focus
- **THEN** the palette transitions to a chooser listing connected MS SQL Server connections; selecting one opens the query tab against it

### Requirement: New Query button on each active connection row

The sidebar SHALL render a `+ Query` icon button in a **primary actions slot** of every active MS SQL Server connection row, distinct from the secondary toolbar slot that hosts refresh + visibility-picker. The button MUST:

- Be **always visible** (never hidden behind hover) while the connection is connected.
- NOT render when the connection is disconnected.
- Use a tone consistent with other sidebar icons (`var(--text-muted)` default, `var(--text)` on hover) — NOT `var(--accent)`, which is reserved for the active dot and selection highlights.
- Carry the tooltip `New SQL query · ⌘↩ runs` so the user discovers the run shortcut.
- Be keyboard-focusable and activatable via Enter/Space.

Activating the button MUST open a new `mssql-query` tab against that connection (equivalent to `SQL: New Query` for that connection).

The secondary toolbar (refresh + visibility-picker) keeps its existing hover-only visibility — those are maintenance actions and the convention is unchanged.

#### Scenario: Button is permanently visible while the connection is connected

- **WHEN** a MS SQL Server connection is connected and visible in the sidebar
- **THEN** the `+ Query` icon button is rendered in the primary actions slot of that row with full opacity
- **AND** the button is visible without the user hovering the row

#### Scenario: Button is hidden on disconnected connection rows

- **WHEN** a MS SQL Server connection is disconnected
- **THEN** its row does NOT display the `+ Query` button

#### Scenario: Activating the button opens a query tab

- **WHEN** the user clicks the `+ Query` button on connection `local-mssql`
- **THEN** a new `mssql-query` tab opens with payload `{ connectionId: <id>, connectionName: "local-mssql", sql: "" }`
- **AND** the editor in that tab takes focus

#### Scenario: Tooltip advertises the run shortcut

- **WHEN** the user hovers the `+ Query` button
- **THEN** a tooltip reads `New SQL query · ⌘↩ runs`

#### Scenario: Refresh and visibility picker remain hover-only

- **WHEN** the user has not hovered the connection row
- **THEN** the refresh icon and visibility-picker icon are NOT visible
- **AND** when the user hovers the row, both icons fade in

### Requirement: Auto-retry on cancellation, manual retry otherwise

When the frontend receives `AppError::Mssql` mapped from `tiberius::error::Error::Cancelled` (surfaced as `AppError::Mssql { code: None, message: "query cancelled", ... }`) from `mssql_list_relations`, it SHALL automatically retry the same call exactly once before surfacing an error state to the user. While the retry is in flight, the schema's `Data` group MUST display a `retrying` indicator distinct from the initial `loading` indicator. If the retry succeeds, the `Data` group renders normally. If the retry also fails, or if the original failure was not a cancellation, the `Data` group MUST render a manually clickable `Retry` affordance whose activation re-runs the load.

The frontend MUST NOT auto-retry `mssql_list_structure`, `mssql_list_table_extras`, or `mssql_get_routine_signature` — for those commands, any error (timeout or otherwise) MUST surface immediately with a manual retry control. The frontend MUST NOT auto-retry on errors other than cancellation for any command. Note: unlike MySQL (which keys auto-retry on SQLSTATE `"70100"`), MS SQL Server uses TDS Attention for cancellation rather than a SQLSTATE code; the auto-retry trigger is therefore `AppError::Mssql { code: None }` with a cancellation-shaped message, not a numeric error code.

#### Scenario: First relations cancellation triggers an automatic retry

- **WHEN** the frontend's first call to `mssql_list_relations` for a schema returns `AppError::Mssql { code: None, message: "query cancelled", ... }`
- **THEN** the schema's `Data` group displays a `retrying` indicator
- **AND** the frontend re-invokes `mssql_list_relations` for the same schema exactly once, without user action

#### Scenario: Successful relations retry recovers the data group

- **WHEN** the auto-retry call returns a successful payload
- **THEN** the `Data` group renders its tables/views normally
- **AND** the `retrying` indicator is removed

#### Scenario: Relations retry failure surfaces a manual retry on the data group

- **WHEN** the auto-retry call also fails (cancellation or any other error)
- **THEN** the `Data` group displays a `Retry` button
- **AND** the group's children show an error placeholder with the typed error message
- **AND** activating the `Retry` button re-runs the load and re-enters the loading flow

#### Scenario: Lazy structure fetch never auto-retries

- **WHEN** the first call to `mssql_list_structure` for a schema returns `AppError::Mssql { code: None, message: "query cancelled", ... }`
- **THEN** the `Structure` group immediately displays a `Retry` button (no automatic retry)
- **AND** activating the `Retry` button re-runs the load

#### Scenario: Lazy table extras fetch never auto-retries

- **WHEN** the first call to `mssql_list_table_extras` for a table returns any error
- **THEN** the table's children display a `Retry` button (no automatic retry)
- **AND** activating it re-invokes `mssql_list_table_extras` for that single relation

#### Scenario: Non-cancellation errors do not auto-retry

- **WHEN** any command's first call returns an `AppError::Mssql` with a numeric `code` (i.e. not a cancellation) or any other `AppError` variant
- **THEN** the corresponding group immediately displays the manual `Retry` button (no automatic retry is dispatched)

### Requirement: List relations command

The MS SQL Server module SHALL expose a Tauri command `mssql_list_relations(id, schema)` that returns every browsable relation in the given schema as a single typed payload `{ schema, tables, views }` (snake_case keys). There is NO `materialized_views` bucket — MS SQL Server has indexed views, but those are surfaced as views with a sub-flag `is_indexed: true`, NOT as a separate bucket. Tables MUST include base tables (rows where `sys.tables.type = 'U'`) and partitioned tables (a base table whose `object_id` has any row in `sys.partitions` with `partition_number > 1`), each carrying `kind: "regular" | "partitioned"`. Views MUST come from `sys.views` (joined to detect `is_indexed`). The command MUST query the `sys.*` catalog (preferred over `INFORMATION_SCHEMA.TABLES` because `sys.*` exposes the partition info and indexed-view flag directly), MUST execute against a client borrowed from the existing pool registry, and SHOULD batch its buckets in a small number of queries (a single `sys.tables` + `sys.views` union filtered by `schema_id` is sufficient; the partitioned-vs-regular determination comes from a `sys.partitions` query; the `is_indexed` flag comes from a `sys.indexes` lookup against view object_ids). Estimated row counts MUST be populated from `sys.dm_db_partition_stats.row_count` summed across all partitions for the heap or clustered index. The command MUST NOT issue `SELECT COUNT(*)` to compute row counts. The command MUST enforce a 10-second total timeout and on expiry MUST issue a TDS Attention via `tokio::select!` dropping the in-flight future and, if cancellation does not return the connection to a clean state, MAY fall back to `KILL <spid>` from a fresh control connection. Cancellation MUST surface `AppError::Mssql { code: None, message: "query cancelled", ... }`. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "list_relations"`, `kind_namespace: "mssql"`, `connection_id: <id>`, `origin: "auto"`, `sql: null`, `params: null`, `metric: { kind: "items", value: <tables + views lengths> }` on success (`null` on failure), and `status` matching the result.

#### Scenario: Empty schema returns empty arrays

- **WHEN** the user invokes `mssql.listRelations(id, "empty")` for a schema that exists but contains no relations
- **THEN** the command returns a payload where `tables` and `views` are empty arrays
- **AND** the response does NOT include a `materialized_views` field

#### Scenario: Mixed-content schema returns each relation kind in its bucket

- **WHEN** the schema `sales` contains 1 regular table, 1 partitioned table, 1 regular view, and 1 indexed view
- **AND** the user invokes `mssql.listRelations(id, "sales")`
- **THEN** the response has 2 tables (one with `kind: "regular"`, one with `kind: "partitioned"`) and 2 views (one with `is_indexed: false`, one with `is_indexed: true`)

#### Scenario: Estimated row counts are populated from sys.dm_db_partition_stats

- **WHEN** a regular table has `sys.dm_db_partition_stats.row_count` summing to 1234567 across its partitions
- **THEN** the table entry has `estimated_rows: 1234567`; the command MUST NOT issue `SELECT COUNT(*)` to compute it

#### Scenario: Partitioned table row count sums across partitions

- **WHEN** a partitioned table has three partitions with row counts 1000, 2000, 3000
- **THEN** the table entry has `estimated_rows: 6000`

#### Scenario: Disconnected connection rejected

- **WHEN** the user invokes `mssql.listRelations(id, schema)` for a connection id that has no registered pool
- **THEN** the command returns `AppError::NotFound` and does not open a connection

#### Scenario: Total timeout cancels via TDS Attention and surfaces cancellation

- **WHEN** `mssql.listRelations` is invoked for a schema whose query takes longer than 10 seconds
- **THEN** at 10 seconds the backend drops the in-flight future (causing `tiberius` to send a TDS Attention) and, if needed, falls back to `KILL <spid>` from a control connection
- **AND** the command returns `AppError::Mssql { code: None, message: "query cancelled", ... }`

#### Scenario: Successful call emits an activity-log entry

- **WHEN** `mssql.listRelations` returns 3 tables and 2 views
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_relations"`, `kind_namespace: "mssql"`, `status: "ok"`, `metric: { kind: "items", value: 5 }`, `origin: "auto"`

#### Scenario: Timeout failure emits an activity-log entry with null code

- **WHEN** `mssql.listRelations` times out
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_relations"`, `kind_namespace: "mssql"`, `status: "err"`, `error.code: null` (cancellations have no numeric SQL Server code)

### Requirement: List structure command with partial-degradation

The MS SQL Server module SHALL expose a Tauri command `mssql_list_structure(id, schema)` that returns the schema's non-relation objects as `{ schema, procedures: Option<Vec<ProcedureInfo>>, functions: Option<Vec<FunctionInfo>>, triggers: Option<Vec<TriggerInfo>>, sequences: Option<Vec<SequenceInfo>>, failures: Vec<KindFailure> }`. Unlike MySQL's single `routines` bucket, MS SQL Server treats procedures and functions as distinct first-class objects so they MUST be returned as separate buckets. There is NO `events` bucket — MS SQL Server has no Event Scheduler equivalent; the closest concept is SQL Agent jobs, which live at the server level (not the database / schema level) and are out of scope. There is NO `extensions` or `types` bucket. The command MUST run the four queries concurrently with `tokio::join!` (NOT `try_join!`), each with a per-query timeout of 8 seconds, and a total command timeout of 10 seconds. When a sub-query fails or times out, the corresponding payload field MUST be `None` and a `KindFailure { kind, code, message }` MUST be appended to `failures` — the other sub-queries MUST still surface their results. Permission-denied (SQL Server error 229 "permission denied on object", 230 "permission denied on column", or 297 "user does not have permission") MUST degrade to `Some(Vec::new())` with a `tracing::warn!` (not a failure entry), preserving the same silent-degradation behavior Postgres uses for `42501` and MySQL uses for `42000`.

`procedures` MUST be sourced from `sys.procedures` joined with `sys.schemas` filtered by `sys.schemas.name = ?`. Each procedure entry MUST include `name`, `created_at`, `modified_at`, and `is_ms_shipped` (so the UI can identify Microsoft-supplied procs even when listed). The entry MUST NOT include `args_signature` or `return_type` — those are resolved on demand via `mssql_get_routine_signature`.

`functions` MUST be sourced from `sys.objects WHERE type IN ('FN','IF','TF','FS','FT')` joined with `sys.schemas`. Each function entry MUST include `name`, `kind` mapped from `sys.objects.type` (`FN` → `"SCALAR_FUNCTION"`, `IF` → `"INLINE_TABLE_VALUED_FUNCTION"`, `TF` → `"TABLE_VALUED_FUNCTION"`, `FS` → `"CLR_SCALAR_FUNCTION"`, `FT` → `"CLR_TABLE_VALUED_FUNCTION"`), `created_at`, `modified_at`. The entry MUST NOT include `args_signature` or `return_type`.

`triggers` MUST be sourced from `sys.triggers` joined with `sys.objects` and `sys.schemas`, filtered by parent-schema membership (including both table-bound triggers and schema-bound DDL triggers). Note that — exactly as MySQL surfaces schema-level triggers in `Structure` even though they also appear per-table — MS SQL Server's `Structure` bucket includes all triggers scoped to the schema's objects so the user can find any trigger by name without expanding individual tables. Each table-bound trigger also continues to appear per-table under `mssql_list_table_extras`.

`sequences` MUST be sourced from `sys.sequences` joined with `sys.schemas`. Each sequence entry MUST include `name`, `start_value`, `increment`, `minimum_value`, `maximum_value`, `current_value`, and `is_cycling`.

The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "list_structure"`, `kind_namespace: "mssql"`, `connection_id: <id>`, `origin: "auto"`, `sql: null`, `params: null`, and `metric: { kind: "items", value: <sum of lengths of Some(...) buckets, treating None as 0> }` on success (`null` on outer failure). `status` is `"ok"` whenever the command itself returns `Ok(...)`, even if `failures` is non-empty.

When the connected server is Azure SQL Database or Managed Instance (detected at handshake via `SELECT SERVERPROPERTY('EngineEdition')` returning 5 or 8), the command MUST skip any sub-query that targets a gated view (`sys.server_principals` etc.) and emit a `tracing::warn!` per skipped sub-query; the corresponding bucket degrades to `Some(Vec::new())` (NOT a `failures` entry, mirroring the permission-denied degradation).

#### Scenario: All sub-queries succeed

- **WHEN** the user invokes `mssql.listStructure(id, "app")` and all four sub-queries succeed
- **THEN** `procedures`, `functions`, `triggers`, and `sequences` are each `Some(...)` populated with results
- **AND** `failures` is an empty array

#### Scenario: Procedures and functions are separate buckets

- **WHEN** the schema has 2 stored procedures and 3 functions (one scalar, one inline TVF, one multi-statement TVF)
- **THEN** `procedures` has 2 entries
- **AND** `functions` has 3 entries — one with `kind: "SCALAR_FUNCTION"`, one with `kind: "INLINE_TABLE_VALUED_FUNCTION"`, one with `kind: "TABLE_VALUED_FUNCTION"`
- **AND** none of them carry `args_signature` or `return_type`

#### Scenario: One sub-query times out, others succeed

- **WHEN** the schema's `sys.procedures` query exceeds the 8-second per-query timeout
- **AND** the `functions`, `triggers`, and `sequences` queries complete in under 1 second
- **THEN** the response has `procedures: None`, `functions: Some([...])`, `triggers: Some([...])`, `sequences: Some([...])`
- **AND** `failures` contains exactly one entry: `{ kind: "procedures", code: null, message: "timed out (8s)" }` (cancellation has no numeric SQL Server code)

#### Scenario: Permission-denied degrades to empty without entering failures

- **WHEN** the connection user lacks privilege to read `sys.sequences` and the server returns error 229 (permission denied)
- **THEN** the response has `sequences: Some([])`
- **AND** `failures` does not include an entry for `sequences`
- **AND** a `tracing::warn!` is emitted on the Rust side

#### Scenario: Azure SQL gated-view skip degrades to empty

- **WHEN** the connected server is Azure SQL Database (`EngineEdition = 5`) and a sub-query would target a gated view (`sys.server_principals`)
- **THEN** the corresponding bucket is `Some([])`
- **AND** `failures` does not include an entry
- **AND** a `tracing::warn!` is emitted naming the skipped view

#### Scenario: Procedure and function entries omit signature

- **WHEN** the user invokes `mssql.listStructure` and the schema contains a function `current_user_id`
- **THEN** the function entry contains `name`, `kind`, `created_at`, `modified_at` but NOT `args_signature` or `return_type`

#### Scenario: Total timeout cancels remaining work

- **WHEN** the total command timeout (10s) expires before all sub-queries finish
- **THEN** the backend drops in-flight futures (causing TDS Attention) and, if needed, issues `KILL <spid>` from a control connection
- **AND** sub-queries that had not yet completed appear in `failures` with `code: null` (cancellation, not a numeric SQL Server code) and a cancellation-shaped message

#### Scenario: All-success call emits an activity-log entry

- **WHEN** `mssql.listStructure` returns 4 procedures, 3 functions, 2 triggers, 1 sequence, no failures
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_structure"`, `kind_namespace: "mssql"`, `status: "ok"`, `metric: { kind: "items", value: 10 }`, `origin: "auto"`

#### Scenario: Partial-failure call still emits ok with smaller item count

- **WHEN** `mssql.listStructure` returns `procedures: None`, `functions: Some(3)`, `triggers: Some(2)`, `sequences: Some(1)`, with one failure entry
- **THEN** one `argus:activity-log` event is emitted with `status: "ok"` and `metric: { kind: "items", value: 6 }`

### Requirement: List table extras command

The MS SQL Server module SHALL expose a Tauri command `mssql_list_table_extras(id, schema, relation)` that returns indexes, triggers, foreign keys, check constraints, and default constraints for **one** relation as `{ schema, relation, indexes: Option<Vec<IndexInfo>>, triggers: Option<Vec<TriggerInfo>>, foreign_keys: Option<Vec<ForeignKeyInfo>>, check_constraints: Option<Vec<CheckConstraintInfo>>, default_constraints: Option<Vec<DefaultConstraintInfo>>, failures: Vec<KindFailure> }`. The five queries MUST run concurrently with `tokio::join!` and partial-degradation semantics identical to `mssql_list_structure`: per-query timeout 8 seconds, total timeout 10 seconds, failures collected in the envelope. SQL Server has check constraints and default constraints as first-class catalog objects, so they appear as their own buckets (unlike MySQL, which does not surface them as schema-browser entries).

`indexes` MUST be sourced from `sys.indexes` joined with `sys.index_columns` and `sys.columns`, filtered by `sys.indexes.object_id = OBJECT_ID(?)` with rows grouped by index and columns within each index collected in `sys.index_columns.key_ordinal` order. Each index entry MUST include `name`, `is_unique`, `is_primary_key` (mapped from `sys.indexes.is_primary_key`), `index_type` mapped from `sys.indexes.type_desc` (one of `"CLUSTERED"`, `"NONCLUSTERED"`, `"XML"`, `"SPATIAL"`, `"COLUMNSTORE"`, `"HEAP"`, etc.), `is_filtered` (mapped from `sys.indexes.has_filter`), and `columns: Array<{ name, key_ordinal, is_descending_key, is_included_column }>`.

`triggers` MUST be sourced from `sys.triggers` joined with `sys.objects` filtered by `sys.triggers.parent_id = OBJECT_ID(?)`. Each trigger entry MUST include `name`, `is_disabled`, `is_instead_of_trigger`, and `events: Array<string>` (mapped from `sys.trigger_events.type_desc`, e.g. `["INSERT", "UPDATE"]`).

`foreign_keys` MUST be sourced from `sys.foreign_keys` joined with `sys.foreign_key_columns`, `sys.tables`, and `sys.schemas` filtered by `sys.foreign_keys.parent_object_id = OBJECT_ID(?)`. Each foreign-key entry MUST include `name` (constraint name), `columns: Array<string>`, `referenced_schema`, `referenced_relation`, `referenced_columns: Array<string>`, `update_action` (mapped from `sys.foreign_keys.update_referential_action_desc`), `delete_action` (mapped from `sys.foreign_keys.delete_referential_action_desc`), and `is_disabled`.

`check_constraints` MUST be sourced from `sys.check_constraints` filtered by `parent_object_id = OBJECT_ID(?)`. Each entry MUST include `name`, `definition` (the constraint expression text), and `is_disabled`.

`default_constraints` MUST be sourced from `sys.default_constraints` joined with `sys.columns` filtered by `parent_object_id = OBJECT_ID(?)`. Each entry MUST include `name`, `column_name`, and `definition`.

The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "list_table_extras"`, `kind_namespace: "mssql"`, `connection_id: <id>`, `origin: "auto"`, `sql: null`, `params: null`, `metric: { kind: "items", value: <indexes len + triggers len + foreign_keys len + check_constraints len + default_constraints len, None → 0> }` on success (`null` on outer failure), and `status` matching whether the command itself returned `Ok` or `Err`.

#### Scenario: All five queries succeed for a table with the full constraint set

- **WHEN** the table `sales.orders` has 3 indexes, 2 triggers, 1 foreign key, 2 check constraints, and 4 default constraints
- **AND** the user invokes `mssql.listTableExtras(id, "sales", "orders")`
- **THEN** the response has `indexes: Some([3 entries])`, `triggers: Some([2 entries])`, `foreign_keys: Some([1 entry])`, `check_constraints: Some([2 entries])`, `default_constraints: Some([4 entries])`
- **AND** `failures` is empty

#### Scenario: Per-table scoping excludes other tables' indexes

- **WHEN** schema `app` contains tables `users` (3 indexes) and `orders` (5 indexes)
- **AND** the user invokes `mssql.listTableExtras(id, "app", "users")`
- **THEN** the response includes only the 3 indexes belonging to `users`

#### Scenario: Composite index columns are ordered by key_ordinal

- **WHEN** a composite index `idx_a_b` has columns `(a, b)` with `key_ordinal` 1 and 2
- **THEN** the index entry's `columns` array is `[{ name: "a", key_ordinal: 1, is_descending_key: false, is_included_column: false }, { name: "b", key_ordinal: 2, ... }]` in that exact order

#### Scenario: Clustered primary key index is marked

- **WHEN** the table has a clustered PRIMARY KEY
- **THEN** the corresponding index entry has `is_primary_key: true`, `is_unique: true`, and `index_type: "CLUSTERED"`

#### Scenario: Filtered index surfaces is_filtered

- **WHEN** the table has a non-clustered filtered index `CREATE INDEX ix ON t(col) WHERE col IS NOT NULL`
- **THEN** the index entry has `is_filtered: true` and `index_type: "NONCLUSTERED"`

#### Scenario: Included columns are distinguished from key columns

- **WHEN** a non-clustered index has key column `a` and included column `b`
- **THEN** the index entry's `columns` array contains `{ name: "a", is_included_column: false }` and `{ name: "b", is_included_column: true }`

#### Scenario: Foreign key surfaces referenced columns and actions

- **WHEN** the table `orders` has `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE NO_ACTION`
- **THEN** the foreign-key entry has `columns: ["user_id"]`, `referenced_relation: "users"`, `referenced_columns: ["id"]`, `update_action: "NO_ACTION"`, `delete_action: "CASCADE"`

#### Scenario: Check constraint surfaces definition text

- **WHEN** the table has `CONSTRAINT ck_qty CHECK (quantity > 0)`
- **THEN** the check-constraint entry has `name: "ck_qty"`, `definition: "(quantity > 0)"` (or the canonical text as returned by `sys.check_constraints.definition`)

#### Scenario: Default constraint surfaces column and definition

- **WHEN** the column `created_at` has a default constraint `DF_orders_created_at DEFAULT (GETDATE())`
- **THEN** the default-constraint entry has `name: "DF_orders_created_at"`, `column_name: "created_at"`, `definition: "(getdate())"` (canonical text from `sys.default_constraints.definition`)

#### Scenario: INSTEAD OF trigger is marked

- **WHEN** a view has an `INSTEAD OF INSERT` trigger
- **THEN** the trigger entry has `is_instead_of_trigger: true` and `events: ["INSERT"]`

#### Scenario: One sub-query fails, the others surface

- **WHEN** the `sys.indexes` query times out at 8 seconds but the other four succeed in 200ms
- **THEN** the response has `indexes: None`, `triggers: Some([...])`, `foreign_keys: Some([...])`, `check_constraints: Some([...])`, `default_constraints: Some([...])`
- **AND** `failures` contains `{ kind: "indexes", code: null, message: "timed out (8s)" }`

#### Scenario: Successful call emits an activity-log entry

- **WHEN** `mssql.listTableExtras` returns 3 indexes, 2 triggers, 1 foreign key, 2 check constraints, 4 default constraints
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_table_extras"`, `kind_namespace: "mssql"`, `status: "ok"`, `metric: { kind: "items", value: 12 }`, `origin: "auto"`

### Requirement: Get routine signature command

The MS SQL Server module SHALL expose a Tauri command `mssql_get_routine_signature(id, schema, name, kind)` that returns `{ args_signature: string, return_type: string | null }` for a single routine identified by the tuple `(schema, name, kind)`, where `kind` is `"procedure" | "function"`. Unlike Postgres functions (which have OIDs and support overloading), MS SQL Server routines are uniquely identified by their schema and name within a kind — MS SQL Server does NOT support overloading, so a procedure or function name is unique within a schema. Therefore no OID equivalent is needed and there are no overloads to disambiguate. The `object_id` from `sys.objects` is stable within a database but not portable, so we identify by name. The command MUST query `sys.parameters` joined with `sys.types` (and `sys.objects` + `sys.schemas` to scope) filtered by `(schema.name, object.name, object.type)` and assemble `args_signature` from the parameter rows in `parameter_id` order. Direction is mapped from `sys.parameters.is_output` combined with the parameter name (e.g. `@user_id INT`, `@total DECIMAL(10,2) OUTPUT`). For functions, `return_type` MUST be populated from the parameter row where `is_output = 1 AND parameter_id = 0` (SQL Server's convention for the function return type — the unnamed `parameter_id = 0` row carries the return type definition). For procedures, `return_type` MUST be `null`. The command MUST enforce a 5-second timeout. Frontend SHALL invoke this lazily — on hover/tooltip of a routine node or on activation of a routine tab — never proactively for the whole list.

#### Scenario: Returns signature for a scalar function

- **WHEN** schema `app` has a function `current_user_id() RETURNS INT`
- **AND** the user invokes `mssql.getRoutineSignature(id, "app", "current_user_id", "function")`
- **THEN** the response is `{ args_signature: "", return_type: "INT" }`

#### Scenario: Returns signature for a stored procedure with input and output parameters

- **WHEN** schema `app` has a procedure `recalc_balances @user_id INT, @total DECIMAL(10,2) OUTPUT`
- **AND** the user invokes `mssql.getRoutineSignature(id, "app", "recalc_balances", "procedure")`
- **THEN** the response is `{ args_signature: "@user_id INT, @total DECIMAL(10,2) OUTPUT", return_type: null }`

#### Scenario: Returns signature for a table-valued function

- **WHEN** schema `app` has an inline TVF `users_for_org(@org_id INT) RETURNS TABLE`
- **AND** the user invokes `mssql.getRoutineSignature(id, "app", "users_for_org", "function")`
- **THEN** the response is `{ args_signature: "@org_id INT", return_type: "TABLE" }`

#### Scenario: Unknown routine returns NotFound

- **WHEN** the user invokes `mssql.getRoutineSignature` for a `(schema, name, kind)` tuple that does not exist
- **THEN** the command returns `AppError::NotFound`

#### Scenario: Timeout returns cancellation

- **WHEN** the catalog lookup exceeds 5 seconds
- **THEN** the command returns `AppError::Mssql { code: None, message: "query cancelled", ... }`

### Requirement: Partial-result envelope contract

Multi-query commands (`mssql_list_structure`, `mssql_list_table_extras`) SHALL return a partial-result envelope where each kind field is `Option<T>` (`None` indicates that kind's sub-query failed) and a `failures: Vec<KindFailure>` collects per-kind failure details. The envelope MUST be serialized to the frontend via `snake_case` JSON keys: `{ "procedures": null, "functions": [...], "triggers": [...], "sequences": [...], "failures": [...] }`. A `KindFailure` MUST contain `kind: string`, `code: Option<i32>` (MS SQL Server numeric error number — NOT a SQLSTATE string; e.g. `229` for permission-denied, `547` for constraint violation, `1205` for deadlock victim, `1222` for lock wait timeout, `18456` for login failed; `null` for cancellation / driver errors that have no numeric SQL Server code), `message: string`. Permission-denied on `sys.*` or `INFORMATION_SCHEMA` (SQL Server errors 229, 230, 297) MUST NOT enter `failures` — it degrades to an empty payload silently with logging. Likewise, Azure-SQL-gated views that are skipped at handshake time MUST NOT enter `failures` — they degrade to empty with `tracing::warn!`.

Note: unlike MySQL's envelope (which carries SQLSTATE strings like `"70100"` and `"42000"`), MS SQL Server's `KindFailure.code` is a typed `i32`. The frontend MUST handle both shapes if it shares rendering logic; the activity-log viewer surfaces the code as a string for display purposes regardless of the underlying numeric type.

#### Scenario: All-success envelope has empty failures

- **WHEN** every sub-query of a multi-query command returns successfully
- **THEN** `failures` is an empty array

#### Scenario: Failure envelope is consumable by frontend

- **WHEN** the response includes `{ "procedures": null, "failures": [{ "kind": "procedures", "code": null, "message": "timed out (8s)" }] }`
- **THEN** the frontend MUST be able to render the structure group with functions / triggers / sequences populated and a per-kind error indicator next to "Procedures"

#### Scenario: Numeric code is preserved in the envelope

- **WHEN** a sub-query fails with SQL Server error 1205 (deadlock victim)
- **THEN** the corresponding `KindFailure` entry has `code: 1205` (typed as `i32`, not the string `"1205"`)

### Requirement: Lazy on-expand fetching of structure and table extras

The frontend SHALL fetch a schema's `Structure` group only when the user expands it (via `SidebarTree`'s expand toggle). Until expansion, no `mssql_list_structure` IPC SHALL be issued for that schema. Similarly, the frontend SHALL fetch a table's indexes / triggers / foreign keys / check constraints / default constraints only when the user expands that table; no `mssql_list_table_extras` SHALL be issued for collapsed tables. The first expansion MUST trigger the fetch; subsequent expand/collapse cycles MUST serve the cached result without re-fetching.

#### Scenario: Collapsed Structure group never fetches

- **WHEN** the user expands a schema and only views the `Data` group
- **THEN** `mssql_list_structure` is NEVER invoked for that schema

#### Scenario: First Structure expand fetches, second does not

- **WHEN** the user expands the `Structure` group of schema `app` for the first time
- **THEN** `mssql.listStructure(id, "app")` is invoked exactly once
- **AND** when the user collapses and re-expands the same group in the same session
- **THEN** the cached payload is rendered and `mssql.listStructure` is not invoked again

#### Scenario: First table expand triggers per-table extras fetch

- **WHEN** the user expands the table `app.users` for the first time
- **THEN** `mssql.listTableExtras(id, "app", "users")` is invoked exactly once
- **AND** other tables' extras are NOT fetched until the user expands them

#### Scenario: Per-table cache is keyed by relation

- **WHEN** the user has expanded `app.users` (causing one `listTableExtras` call)
- **AND** the user expands `app.orders` for the first time
- **THEN** `mssql.listTableExtras` is invoked once more, with `relation: "orders"`
- **AND** re-expanding `app.users` does NOT re-fetch

### Requirement: New SQL Query item in connection-row context menu

The right-click context menu on a MS SQL Server connection row SHALL include a `New SQL Query` item at the top of the menu when the connection is connected. The item MUST:

- Sit above the existing `Edit / Duplicate / Delete` items.
- Be separated from the modification items by a visual separator.
- Open a new `mssql-query` tab against that connection when activated (same handler as the `+ Query` button).
- NOT appear when the connection is disconnected.

#### Scenario: New SQL Query appears for connected connections

- **WHEN** the user right-clicks a connected MS SQL Server connection row
- **THEN** the context menu shows `New SQL Query` as its first item, followed by a separator, then `Edit`, `Duplicate`, `Delete`

#### Scenario: New SQL Query is hidden for disconnected connections

- **WHEN** the user right-clicks a disconnected MS SQL Server connection row
- **THEN** the context menu shows `Edit`, `Duplicate`, `Delete` only — no `New SQL Query` item, no leading separator

#### Scenario: Activating the menu item opens a query tab

- **WHEN** the user right-clicks a connected connection row and selects `New SQL Query`
- **THEN** a new `mssql-query` tab opens against that connection with an empty SQL buffer
- **AND** the editor in that tab takes focus

### Requirement: Context folder integration

The MSSQL schema browser SHALL surface context-folder documentation when the connection has a linked folder: a `📄` badge after the label of tree nodes that match a documented relation, a "Docs" subtab in the detail view rendering the parsed object's body and `human:` chips, column-note decoration in the structure subtab, and an unavailability banner above the tree when the folder is in `Unavailable` state. All four surfaces consume the existing shared components from `src/modules/context/components/` and the `useContextObjects` / `useContextObject` hooks.

#### Scenario: Tree shows badge for documented relation

- **WHEN** an MSSQL connection is linked to a folder containing `mssql/dbo/Users.md`
- **AND** the schema browser renders the `dbo` schema's tables
- **THEN** the `Users` node renders a `📄` badge after its label

#### Scenario: Docs subtab visible when relation has doc

- **WHEN** the user selects `dbo.Users` and the relation has a documented object
- **THEN** the detail view's `SubtabHeader` includes a "Docs" entry
- **AND** activating it renders the `DocsSubtab` with the body and chips

#### Scenario: Column notes decorate structure subtab

- **WHEN** the selected relation has `human.column_notes: { Email: "lowercased before insert" }`
- **THEN** the structure subtab's `Email` row shows the note string as an inline annotation

#### Scenario: Unavailability banner appears

- **WHEN** an MSSQL connection is linked to a folder whose root has been deleted on disk
- **THEN** an unavailability banner is rendered above the schema tree

