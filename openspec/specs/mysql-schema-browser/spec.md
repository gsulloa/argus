# mysql-schema-browser Specification

## Purpose
TBD - created by archiving change add-mysql-support. Update Purpose after archive.
## Requirements
### Requirement: List schemas command

The MySQL module SHALL expose a Tauri command `mysql_list_schemas(id)` that returns every schema (a.k.a. database — MySQL uses the terms interchangeably) visible to the connection user as `Array<{ name: string, charset: string, collation: string, is_system: boolean }>` (snake_case keys, matching the rest of the MySQL module's IPC surface). The underlying query MUST source rows from `INFORMATION_SCHEMA.SCHEMATA` (equivalent to `SHOW DATABASES` but with charset/collation columns available). A schema MUST be marked `is_system: true` when its name matches one of `mysql`, `information_schema`, `performance_schema`, or `sys`. Results MUST be ordered alphabetically by `name`, case-insensitive. The command MUST acquire a connection from the existing pool registry and MUST NOT open a new connection. The command MUST enforce a 10-second total timeout. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "list_schemas"`, `connection_id: <id>`, `origin: "auto"`, `sql: null`, `params: null`, `metric: { kind: "items", value: <returned schemas length> }` on success (`null` on failure), and `status` matching the result.

#### Scenario: Listing schemas on a fresh connection

- **WHEN** the user invokes `mysql.listSchemas(id)` for an active connection on a server with `app`, `analytics`, `mysql`, `information_schema`, `performance_schema`, `sys`
- **THEN** the command returns six entries; `app` and `analytics` have `is_system: false`; `mysql`, `information_schema`, `performance_schema`, and `sys` have `is_system: true`

#### Scenario: Charset and collation are surfaced

- **WHEN** the user invokes `mysql.listSchemas(id)` and the schema `app` was created with `CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
- **THEN** the entry for `app` has `charset: "utf8mb4"` and `collation: "utf8mb4_0900_ai_ci"`

#### Scenario: Alphabetical case-insensitive ordering

- **WHEN** the server contains schemas `Zebra`, `apple`, `Mango`
- **AND** the user invokes `mysql.listSchemas(id)`
- **THEN** the returned array is ordered `apple`, `Mango`, `Zebra` (case-insensitive ascending)

#### Scenario: Disconnected connection rejected

- **WHEN** the user invokes `mysql.listSchemas(id)` for a connection id that has no registered pool
- **THEN** the command returns `AppError::NotFound` (no pool registered) and does not open a connection

#### Scenario: Successful call emits an activity-log entry

- **WHEN** `mysql.listSchemas(id)` returns 6 schemas
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_schemas"`, `status: "ok"`, `metric: { kind: "items", value: 6 }`, `origin: "auto"`

#### Scenario: Failing call emits an activity-log entry with error

- **WHEN** `mysql.listSchemas(id)` is invoked for a disconnected id
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_schemas"`, `status: "err"`, `metric: null`

### Requirement: Frontend tree label for MySQL

The frontend SHALL render the top-level schema-grouping label as "Databases" (not "Schemas") for any MySQL connection row in the sidebar, picker dialogs, and palette commands that display a noun for the grouping. Internally, the data model, settings keys, IPC payloads, and command names continue to use the term `schema` for consistency with the Postgres-side terminology. This is a presentation-only override.

#### Scenario: Sidebar visibility picker label

- **WHEN** the user opens the visibility picker for a MySQL connection
- **THEN** the picker title reads "Databases" (not "Schemas")
- **AND** the underlying setting key remains `mysqlVisibleSchemas:<connectionId>`

#### Scenario: Palette command labels keep "Schema" terminology

- **WHEN** the user opens the command palette while focused on a MySQL connection
- **THEN** the palette still surfaces `Schema: Refresh` and `Schema: Filter Visible…` (internal naming is preserved; only the data-grouping noun in display surfaces is renamed)

### Requirement: Schema cache and invalidation

The frontend SHALL cache schema-browser data in a **process-wide** store keyed by `(connectionId, schema)` with sub-keys for each lazy group. The per-schema cache MUST hold three independent slots: `relations` (eager), `structure` (lazy), and a `Map<relation, tableExtras>` (lazy per-table). Each slot MUST be populated on first need and MUST be served on subsequent reads without re-fetching.

The cache MUST survive unmount/remount of the connection's subtree. On mount, `useSchemaTree` MUST seed its local state machine from the process-wide cache: if a non-stale schemas entry exists for the connection, the tree MUST initialize to a loaded state (and seed any cached `relations` slots as loaded) **without** issuing `mysql.listSchemas` or `mysql.listRelations`. Switching focus away from and back to a connection MUST NOT, by itself, drop the cache or trigger a refetch.

Each connection's schemas-level cache entry MUST record a `fetchedAt` timestamp. An entry is **stale** when it is older than the TTL (`SCHEMA_CACHE_TTL_MS`, 1 hour). When a connection is mounted (e.g. refocused) and its entry is stale, the tree MUST render the cached data immediately and refresh in the background (`mysql.listSchemas` followed by eager `mysql.listRelations` for visible schemas); on success the cache is replaced and the tree re-renders; on failure the stale data is retained.

The cache MUST be invalidated for an entire connection when (a) the user invokes `Schema: Refresh` from the palette, the connection row's refresh button, or the global `Cmd+R` / `Ctrl+R` accelerator while the connection is focused, or (b) a `mysql:active-changed` event reports the connection as no longer active. Individual group slots MAY be invalidated independently when the user activates an inline retry button on a failed group. The cache MUST NOT be persisted to disk.

#### Scenario: First relations expand fetches; second does not

- **WHEN** the user makes schema `app` visible for the first time in a session
- **THEN** the command `mysql.listRelations(id, "app")` is invoked exactly once
- **AND** when the schema is hidden via the picker and re-shown in the same session
- **THEN** the cached payload is rendered and `mysql.listRelations` is not invoked again

#### Scenario: Group cache slots are independent

- **WHEN** the `relations` slot has loaded successfully and the `structure` slot is in error state
- **AND** the user activates the inline retry button on the `structure` group
- **THEN** only `mysql.listStructure` is re-invoked; the relations slot is not touched

#### Scenario: Refocusing a loaded connection serves cache without refetch

- **WHEN** a connection's schemas (and visible-schema relations) have loaded and the user switches focus to another connection in the rail and then back within the TTL window
- **THEN** the schema tree renders immediately from the cache
- **AND** neither `mysql.listSchemas` nor `mysql.listRelations` is invoked again on the refocus

#### Scenario: Stale entry past TTL refreshes in the background

- **WHEN** the user refocuses a connection whose cached schemas entry is older than `SCHEMA_CACHE_TTL_MS`
- **THEN** the tree renders the stale cached data immediately
- **AND** `mysql.listSchemas` is re-invoked in the background and the tree re-renders on success without an intervening blank/loading state

#### Scenario: Refresh palette command clears the connection's full cache

- **WHEN** the user runs `Schema: Refresh` from the palette while focused on a connection
- **THEN** every cached entry for that connection is dropped — `relations`, `structure`, and per-table `tableExtras` for every schema
- **AND** the next visibility/expand of any group re-invokes the corresponding command

#### Scenario: Disconnect drops the cache

- **WHEN** the user disconnects a connection
- **THEN** every cached entry for that connection id is dropped
- **AND** if the user reconnects and re-views a schema, the relevant commands are invoked

### Requirement: Visible schemas filter

The MySQL module SHALL persist a per-connection setting `mysqlVisibleSchemas:<connectionId>` containing a JSON array of schema names. When the setting is unset, the schema tree MUST default to showing all non-system schemas (system schemas remain available behind a "Show system schemas" toggle in the picker). When the setting is set, the tree MUST render only the listed schemas in the order returned by `mysql.listSchemas`. Toggling a schema in the picker MUST persist immediately and update the tree on the next render.

#### Scenario: Default visibility hides system schemas

- **WHEN** the user opens a connection for the first time and has no `mysqlVisibleSchemas:<id>` setting
- **THEN** the tree renders every schema returned by `listSchemas` for which `is_system === false`
- **AND** schemas with `is_system === true` are not rendered until "Show system schemas" is toggled in the picker

#### Scenario: Picker selection persists per connection

- **WHEN** the user opens the picker, unchecks `analytics`, and closes the picker
- **THEN** `analytics` is removed from the tree
- **AND** the `mysqlVisibleSchemas:<id>` setting reflects the new selection
- **AND** the next time the user opens the same connection in a future app session, `analytics` remains hidden

#### Scenario: Selection is per connection

- **WHEN** the user has hidden `analytics` for connection A
- **AND** the user opens connection B which also has an `analytics` schema
- **THEN** connection B's tree shows `analytics` (default behavior; A's setting does not leak to B)

### Requirement: Schema tree UI under each active connection

The frontend SHALL render a navigable schema tree directly underneath each active MySQL connection row in the sidebar. The tree MUST consume the platform's `SidebarTree` primitive. Each schema node MUST be expandable to reveal exactly two child groups: `Data` (containing all tables and views in that schema, mixed and ordered alphabetically by name, case-insensitive) and `Structure` (containing all routines, triggers, and events in that schema, mixed and ordered alphabetically by name, case-insensitive). The `Data` group's contents come from the eager `mysql_list_relations` fetch; the `Structure` group's contents come from a lazy `mysql_list_structure` fetch triggered on first expansion of that group. The kind of an item MUST be communicated by a kind-specific icon and, where multiple variants share an icon, a small text badge (for example `partitioned` on partitioned tables). Each table node MUST be further expandable to reveal its indexes, triggers, and foreign keys as nested children grouped under `Indexes`, `Triggers`, and `Foreign Keys` sub-nodes — those sub-groups' contents come from a lazy `mysql_list_table_extras` fetch triggered on first expansion of the parent table. Indexes, triggers, and foreign keys MUST NOT appear as top-level items in the `Structure` group. Routine nodes MUST display the routine `name` followed by a small text badge indicating kind (`PROC` for stored procedures, `FUNC` for stored functions). Because MySQL does NOT support routine overloading (a procedure or function name is unique within a schema), no name-disambiguation rule applies.

#### Scenario: Tree appears on connect, disappears on disconnect

- **WHEN** the user clicks a MySQL connection row to connect, and the connect succeeds
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

#### Scenario: Table node lazy-loads indexes, triggers, and foreign keys on expand

- **WHEN** the user expands a table node for the first time
- **THEN** `mysql_list_table_extras(id, schema, relation)` is invoked
- **AND** until the response arrives, the table's children show a "Loading…" placeholder
- **AND** on success, the table's children are three sub-groups, `Indexes`, `Triggers`, and `Foreign Keys`, containing the corresponding entries

#### Scenario: Partitioned tables carry a badge

- **WHEN** the tree renders a table whose `kind` is `"partitioned"`
- **THEN** the table node displays a small text badge `partitioned` after the name, while sharing the regular-table icon

#### Scenario: Routine kind badge

- **WHEN** the `Structure` group contains a stored procedure `recalc_balances` and a stored function `current_user_id`
- **THEN** the tree renders both nodes
- **AND** the procedure node displays a `PROC` badge after the name
- **AND** the function node displays a `FUNC` badge after the name

#### Scenario: Failed group renders inline error with retry

- **WHEN** the lazy `mysql_list_structure` fetch fails entirely (e.g. connection lost)
- **THEN** the `Structure` group renders a placeholder "Failed to load. (Retry)"
- **AND** the `Data` group renders normally with its tables/views
- **AND** activating the inline `Retry` re-invokes `mysql_list_structure` for that schema only

#### Scenario: Partial failure renders surviving kinds with per-kind retry

- **WHEN** `mysql_list_structure` returns `{ routines: null, triggers: [...], events: [...], failures: [{ kind: "routines", ... }] }`
- **THEN** the `Structure` group renders triggers and events normally
- **AND** an inline placeholder "Routines failed (Retry)" appears in place of the routines
- **AND** activating the per-kind `Retry` re-invokes `mysql_list_structure` (re-running all three sub-queries; the cache is replaced on success)

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
- **THEN** no `mysql.listRelations` calls are dispatched
- **AND** the empty-result UI mentions that N schemas have not been loaded yet

#### Scenario: Match count indicator

- **WHEN** the user has an active search returning 7 visible matches across 42 loaded objects
- **THEN** the search input shows an inline indicator "7 of 42"

### Requirement: Activating a node opens an object placeholder tab

The frontend SHALL respond to node activation (Enter key, single click, or double click — equivalent in V1) on any object node by opening or focusing a center-area tab. Activation on a table or view node MUST open or focus a tab of kind `mysql-table-data` (defined by the `mysql-data-grid` capability) with payload `{ connectionId, connectionName, schema, relation, relationKind: "table" | "view" }` and stable id `mytbl:<connectionId>:<schema>:<relation>`. Activation on any other object kind (routine, trigger, event, index, foreign key) MUST open or focus a tab of kind `mysql-object-placeholder` with payload `{ connectionId, schema, kind, name }` plus any kind-specific identifiers (such as a routine's `kind` discriminator `"procedure" | "function"`) and the existing stable id pattern. Activation on group nodes (Data, Structure, Indexes, Triggers, Foreign Keys) MUST NOT open a tab; it MUST only toggle expansion.

#### Scenario: Click a table opens the data viewer tab

- **WHEN** the user activates a table node `analytics.events`
- **THEN** a center-area tab of kind `mysql-table-data` opens with payload `{ connectionId, connectionName, schema: "analytics", relation: "events", relationKind: "table" }`
- **AND** the placeholder tab is NOT opened

#### Scenario: Click a view opens the data viewer tab

- **WHEN** the user activates a view node
- **THEN** the same `mysql-table-data` tab opens with `relationKind: "view"`

#### Scenario: Click a routine opens the placeholder tab

- **WHEN** the user activates a routine node (procedure or function)
- **THEN** a center-area tab of kind `mysql-object-placeholder` opens with payload `{ connectionId, schema, kind: "routine", name, routineKind: "procedure" | "function" }`
- **AND** the tab's body shows a placeholder text identifying the object and stating that the viewer is not implemented yet

#### Scenario: Click a trigger, event, index, or foreign key opens the placeholder tab

- **WHEN** the user activates a trigger, event, index, or foreign key node
- **THEN** a center-area tab of kind `mysql-object-placeholder` opens with the corresponding payload

#### Scenario: Activating the same node twice focuses the existing tab

- **WHEN** the user activates the same object node a second time (regardless of whether it routes to `mysql-table-data` or `mysql-object-placeholder`)
- **THEN** the existing tab is focused; a new tab is not opened

#### Scenario: Group node activation does not open a tab

- **WHEN** the user activates the "Data", "Structure", "Indexes", "Triggers", or "Foreign Keys" group node
- **THEN** the group toggles expansion; no tab is opened

### Requirement: Palette commands for schema browsing

The MySQL module SHALL register the following commands in the `command-palette` registry on app start: `Schema: Refresh` (drops the schema cache for the focused connection and re-fetches schemas), `Schema: Filter Visible…` (opens the visible-schemas picker for the focused connection), `SQL: New Query` (opens a new `mysql-query` tab against the focused connection), and `SQL: New Query Here` (opens a new `mysql-query` tab pre-populated with SQL contextual to the focused sidebar node). When no connection is focused, all four commands MUST transition the palette to a connection chooser.

`SQL: New Query` MUST always open with an empty SQL buffer. `SQL: New Query Here` MUST pre-populate the buffer based on the focused node. All generated SQL MUST use MySQL identifier quoting — backticks (`` ` ``), never double-quotes:

- Connection focused → empty buffer (equivalent to `SQL: New Query`).
- Schema focused → `` USE `<schema>`;\n\n `` (backtick-quoted identifier; MySQL uses `USE database` rather than `SET search_path`).
- Table or view focused → `` SELECT * FROM `<schema>`.`<relation>` LIMIT 100; `` (backtick-quoted identifiers on both schema and relation).
- Any other node kind (routine, trigger, event, index, foreign key) → empty buffer with the connection set to the focused node's connection.

#### Scenario: Refresh on focused connection clears its cache

- **WHEN** the user has a connection focused and runs `Schema: Refresh`
- **THEN** the cache for that connection is dropped, `mysql.listSchemas` is re-invoked, and the tree re-renders with the new result

#### Scenario: Filter Visible opens the picker

- **WHEN** the user has a connection focused and runs `Schema: Filter Visible…`
- **THEN** the visible-schemas picker for that connection opens

#### Scenario: Commands without a focused connection show a chooser

- **WHEN** the user runs `Schema: Refresh` with no sidebar connection focused
- **THEN** the palette transitions to a chooser listing connected MySQL connections; selecting one runs the refresh

#### Scenario: New Query opens a fresh empty query tab

- **WHEN** the user has a connection focused and runs `SQL: New Query`
- **THEN** a new `mysql-query` tab opens against that connection with an empty SQL buffer

#### Scenario: New Query Here on a table pre-populates a SELECT with backticks

- **WHEN** the user has the table `analytics.events` focused in the sidebar and runs `SQL: New Query Here`
- **THEN** a new `mysql-query` tab opens with SQL `` SELECT * FROM `analytics`.`events` LIMIT 100; ``
- **AND** the cursor lands at the end of the document so the user can immediately edit or run

#### Scenario: New Query Here on a schema emits USE statement

- **WHEN** the user has the schema `analytics` focused and runs `SQL: New Query Here`
- **THEN** a new `mysql-query` tab opens with SQL `` USE `analytics`; `` followed by two newlines

#### Scenario: New Query without a focused connection prompts a chooser

- **WHEN** the user runs `SQL: New Query` with no sidebar focus
- **THEN** the palette transitions to a chooser listing connected MySQL connections; selecting one opens the query tab against it

### Requirement: New Query button on each active connection row

The sidebar SHALL render a `+ Query` icon button in a **primary actions slot** of every active MySQL connection row, distinct from the secondary toolbar slot that hosts refresh + visibility-picker. The button MUST:

- Be **always visible** (never hidden behind hover) while the connection is connected.
- NOT render when the connection is disconnected.
- Use a tone consistent with other sidebar icons (`var(--text-muted)` default, `var(--text)` on hover) — NOT `var(--accent)`, which is reserved for the active dot and selection highlights.
- Carry the tooltip `New SQL query · ⌘↩ runs` so the user discovers the run shortcut.
- Be keyboard-focusable and activatable via Enter/Space.

Activating the button MUST open a new `mysql-query` tab against that connection (equivalent to `SQL: New Query` for that connection).

The secondary toolbar (refresh + visibility-picker) keeps its existing hover-only visibility — those are maintenance actions and the convention is unchanged.

#### Scenario: Button is permanently visible while the connection is connected

- **WHEN** a MySQL connection is connected and visible in the sidebar
- **THEN** the `+ Query` icon button is rendered in the primary actions slot of that row with full opacity
- **AND** the button is visible without the user hovering the row

#### Scenario: Button is hidden on disconnected connection rows

- **WHEN** a MySQL connection is disconnected
- **THEN** its row does NOT display the `+ Query` button

#### Scenario: Activating the button opens a query tab

- **WHEN** the user clicks the `+ Query` button on connection `local-mysql`
- **THEN** a new `mysql-query` tab opens with payload `{ connectionId: <id>, connectionName: "local-mysql", sql: "" }`
- **AND** the editor in that tab takes focus

#### Scenario: Tooltip advertises the run shortcut

- **WHEN** the user hovers the `+ Query` button
- **THEN** a tooltip reads `New SQL query · ⌘↩ runs`

#### Scenario: Refresh and visibility picker remain hover-only

- **WHEN** the user has not hovered the connection row
- **THEN** the refresh icon and visibility-picker icon are NOT visible
- **AND** when the user hovers the row, both icons fade in

### Requirement: Auto-retry on timeout, manual retry otherwise

When the frontend receives `AppError::Mysql` with code `"70100"` (MySQL's `ER_QUERY_INTERRUPTED` SQLSTATE, the cancellation equivalent of Postgres `57014`) from `mysql_list_relations`, it SHALL automatically retry the same call exactly once before surfacing an error state to the user. While the retry is in flight, the schema's `Data` group MUST display a `retrying` indicator distinct from the initial `loading` indicator. If the retry succeeds, the `Data` group renders normally. If the retry also fails, or if the original failure was not a cancellation, the `Data` group MUST render a manually clickable `Retry` affordance whose activation re-runs the load.

The frontend MUST NOT auto-retry `mysql_list_structure`, `mysql_list_table_extras`, or `mysql_get_routine_signature` — for those commands, any error (timeout or otherwise) MUST surface immediately with a manual retry control. The frontend MUST NOT auto-retry on errors other than `"70100"` for any command.

#### Scenario: First relations timeout triggers an automatic retry

- **WHEN** the frontend's first call to `mysql_list_relations` for a schema returns `AppError::Mysql` with code `"70100"`
- **THEN** the schema's `Data` group displays a `retrying` indicator
- **AND** the frontend re-invokes `mysql_list_relations` for the same schema exactly once, without user action

#### Scenario: Successful relations retry recovers the data group

- **WHEN** the auto-retry call returns a successful payload
- **THEN** the `Data` group renders its tables/views normally
- **AND** the `retrying` indicator is removed

#### Scenario: Relations retry failure surfaces a manual retry on the data group

- **WHEN** the auto-retry call also fails (timeout or any other error)
- **THEN** the `Data` group displays a `Retry` button
- **AND** the group's children show an error placeholder with the typed error message
- **AND** activating the `Retry` button re-runs the load and re-enters the loading flow

#### Scenario: Lazy structure fetch never auto-retries

- **WHEN** the first call to `mysql_list_structure` for a schema returns `AppError::Mysql` with code `"70100"`
- **THEN** the `Structure` group immediately displays a `Retry` button (no automatic retry)
- **AND** activating the `Retry` button re-runs the load

#### Scenario: Lazy table extras fetch never auto-retries

- **WHEN** the first call to `mysql_list_table_extras` for a table returns any error
- **THEN** the table's children display a `Retry` button (no automatic retry)
- **AND** activating it re-invokes `mysql_list_table_extras` for that single relation

#### Scenario: Non-cancellation errors do not auto-retry

- **WHEN** any command's first call returns an `AppError` other than `Mysql { code: "70100" }`
- **THEN** the corresponding group immediately displays the manual `Retry` button (no automatic retry is dispatched)

### Requirement: List relations command

The MySQL module SHALL expose a Tauri command `mysql_list_relations(id, schema)` that returns every browsable relation in the given schema as a single typed payload `{ schema, tables, views }` (snake_case keys). There is NO `materialized_views` bucket — MySQL does not support materialized views as a native object. Tables MUST include base tables (`INFORMATION_SCHEMA.TABLES.TABLE_TYPE = 'BASE TABLE'`) and partitioned tables (a base table whose `TABLE_NAME` appears in `INFORMATION_SCHEMA.PARTITIONS` with a non-NULL `PARTITION_NAME`), each carrying `kind: "regular" | "partitioned"`. Views MUST come from `INFORMATION_SCHEMA.TABLES.TABLE_TYPE = 'VIEW'`. The command MUST query `INFORMATION_SCHEMA` (not `mysql` system tables directly), MUST execute against a client borrowed from the existing pool registry, and SHOULD batch both buckets in a small number of queries (a single `INFORMATION_SCHEMA.TABLES` scan filtered by `TABLE_SCHEMA = ?` is sufficient; the partitioned-vs-regular determination comes from a second `INFORMATION_SCHEMA.PARTITIONS` query). Estimated row counts MUST be populated from `INFORMATION_SCHEMA.TABLES.TABLE_ROWS` (note: for InnoDB this is a storage-engine estimate that may diverge wildly from reality; the command surfaces it as-is and MUST NOT issue a `SELECT COUNT(*)` to compute it). The command MUST enforce a 10-second total timeout and on expiry MUST issue a server-side `KILL QUERY <conn-id>` against the borrowed connection's process id, drop the in-flight task, and return `AppError::Mysql { code: Some("70100"), message }`. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "list_relations"`, `connection_id: <id>`, `origin: "auto"`, `sql: null`, `params: null`, `metric: { kind: "items", value: <tables + views lengths> }` on success (`null` on failure), and `status` matching the result.

#### Scenario: Empty schema returns empty arrays

- **WHEN** the user invokes `mysql.listRelations(id, "empty")` for a schema that exists but contains no relations
- **THEN** the command returns a payload where `tables` and `views` are empty arrays
- **AND** the response does NOT include a `materialized_views` field

#### Scenario: Mixed-content schema returns each relation kind in its bucket

- **WHEN** the schema `analytics` contains 1 regular table, 1 partitioned table, and 1 view
- **AND** the user invokes `mysql.listRelations(id, "analytics")`
- **THEN** the response has 2 tables (one with `kind: "regular"`, one with `kind: "partitioned"`) and 1 view

#### Scenario: Estimated row counts are populated from INFORMATION_SCHEMA.TABLES

- **WHEN** a regular table has `INFORMATION_SCHEMA.TABLES.TABLE_ROWS = 1234567`
- **THEN** the table entry has `estimated_rows: 1234567`; the command MUST NOT issue `SELECT COUNT(*)` to compute it

#### Scenario: InnoDB estimate inaccuracy is surfaced as-is

- **WHEN** an InnoDB table's actual row count is 100 but `TABLE_ROWS` reports 87
- **THEN** the response surfaces `estimated_rows: 87` without correction (the inaccuracy is an InnoDB property, not an Argus bug)

#### Scenario: Disconnected connection rejected

- **WHEN** the user invokes `mysql.listRelations(id, schema)` for a connection id that has no registered pool
- **THEN** the command returns `AppError::NotFound` and does not open a connection

#### Scenario: Total timeout cancels via KILL QUERY and surfaces 70100

- **WHEN** `mysql.listRelations` is invoked for a schema whose query takes longer than 10 seconds
- **THEN** at 10 seconds the backend issues `KILL QUERY <conn-id>` on a sibling control connection for the in-flight query's connection id
- **AND** the command returns `AppError::Mysql` with code `"70100"`

#### Scenario: Successful call emits an activity-log entry

- **WHEN** `mysql.listRelations` returns 3 tables and 2 views
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_relations"`, `status: "ok"`, `metric: { kind: "items", value: 5 }`, `origin: "auto"`

#### Scenario: Timeout failure emits an activity-log entry with code

- **WHEN** `mysql.listRelations` times out
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_relations"`, `status: "err"`, `error.code: "70100"`

### Requirement: List structure command with partial-degradation

The MySQL module SHALL expose a Tauri command `mysql_list_structure(id, schema)` that returns the schema's non-relation objects as `{ schema, routines: Option<Vec<RoutineInfo>>, triggers: Option<Vec<TriggerInfo>>, events: Option<Vec<EventInfo>>, failures: Vec<KindFailure> }`. There are NO `functions`, `types`, or `extensions` buckets — MySQL does not expose those as schema-level objects (UDFs are server-global and exotic, SQL types are part of the standard, and there is no extension system). The command MUST run the three queries concurrently with `tokio::join!` (NOT `try_join!`), each with a per-query timeout of 8 seconds, and a total command timeout of 10 seconds. When a sub-query fails or times out, the corresponding payload field MUST be `None` and a `KindFailure { kind, code, message }` MUST be appended to `failures` — the other sub-queries MUST still surface their results. Permission-denied (SQLSTATE `42000` with a message indicating SELECT was denied on `INFORMATION_SCHEMA`) MUST degrade to `Some(Vec::new())` with a `tracing::warn!` (not a failure entry), preserving the same silent-degradation behavior Postgres uses for `42501`.

`routines` MUST be sourced from `INFORMATION_SCHEMA.ROUTINES` filtered by `ROUTINE_SCHEMA = ?`, including both stored procedures and stored functions. Each routine entry MUST include `name`, `kind: "procedure" | "function"` (mapped from `ROUTINE_TYPE`), `language` (typically `"SQL"`), and `comment`. The entry MUST NOT include `args_signature` or `return_type` — those are resolved on demand via `mysql_get_routine_signature`. Note that MySQL does NOT support routine overloading, so `(schema, name, kind)` is a sufficient unique identifier.

`triggers` MUST be sourced from `INFORMATION_SCHEMA.TRIGGERS` filtered by `TRIGGER_SCHEMA = ?`. Note that in Postgres, triggers are per-table only and appear under each table; in MySQL we include schema-level triggers in the `Structure` group as well, because `SHOW TRIGGERS` and `INFORMATION_SCHEMA.TRIGGERS` are database-scoped. This is a deliberate dialect difference. Triggers also continue to appear per-table under `mysql_list_table_extras`.

`events` MUST be sourced from `INFORMATION_SCHEMA.EVENTS` filtered by `EVENT_SCHEMA = ?` (the MySQL Event Scheduler).

The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "list_structure"`, `connection_id: <id>`, `origin: "auto"`, `sql: null`, `params: null`, and `metric: { kind: "items", value: <sum of lengths of Some(...) buckets, treating None as 0> }` on success (`null` on outer failure). `status` is `"ok"` whenever the command itself returns `Ok(...)`, even if `failures` is non-empty.

#### Scenario: All sub-queries succeed

- **WHEN** the user invokes `mysql.listStructure(id, "app")` and all three sub-queries succeed
- **THEN** `routines`, `triggers`, and `events` are each `Some(...)` populated with results
- **AND** `failures` is an empty array

#### Scenario: Routines contain both procedures and functions

- **WHEN** the schema has 2 stored procedures and 1 stored function
- **THEN** `routines` has 3 entries — two with `kind: "procedure"` and one with `kind: "function"`
- **AND** none of them carry `args_signature` or `return_type`

#### Scenario: One sub-query times out, others succeed

- **WHEN** the schema's `INFORMATION_SCHEMA.ROUTINES` query exceeds the 8-second per-query timeout
- **AND** the `TRIGGERS` and `EVENTS` queries complete in under 1 second
- **THEN** the response has `routines: None`, `triggers: Some([...])`, `events: Some([...])`
- **AND** `failures` contains exactly one entry: `{ kind: "routines", code: "70100", message: "..." }`

#### Scenario: Permission-denied degrades to empty without entering failures

- **WHEN** the connection user lacks privilege to read `INFORMATION_SCHEMA.EVENTS` and the server returns SQLSTATE `42000` with a SELECT-denied message
- **THEN** the response has `events: Some([])`
- **AND** `failures` does not include an entry for `events`
- **AND** a `tracing::warn!` is emitted on the Rust side

#### Scenario: Routine entries omit signature

- **WHEN** the user invokes `mysql.listStructure` and the schema contains a function `current_user_id`
- **THEN** the routine entry contains `name`, `kind`, `language`, `comment` but NOT `args_signature` or `return_type`

#### Scenario: Total timeout cancels remaining work

- **WHEN** the total command timeout (10s) expires before all sub-queries finish
- **THEN** the backend issues `KILL QUERY <conn-id>` and drops the client
- **AND** sub-queries that had not yet completed appear in `failures` with code `"70100"`

#### Scenario: All-success call emits an activity-log entry

- **WHEN** `mysql.listStructure` returns 4 routines, 2 triggers, 1 event, no failures
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_structure"`, `status: "ok"`, `metric: { kind: "items", value: 7 }`, `origin: "auto"`

#### Scenario: Partial-failure call still emits ok with smaller item count

- **WHEN** `mysql.listStructure` returns `routines: None`, `triggers: Some(2)`, `events: Some(1)`, with one failure entry
- **THEN** one `argus:activity-log` event is emitted with `status: "ok"` and `metric: { kind: "items", value: 3 }`

### Requirement: List table extras command

The MySQL module SHALL expose a Tauri command `mysql_list_table_extras(id, schema, relation)` that returns indexes, triggers, and foreign keys for **one** relation as `{ schema, relation, indexes: Option<Vec<IndexInfo>>, triggers: Option<Vec<TriggerInfo>>, foreign_keys: Option<Vec<ForeignKeyInfo>>, failures: Vec<KindFailure> }`. The three queries MUST run concurrently with `tokio::join!` and partial-degradation semantics identical to `mysql_list_structure`: per-query timeout 8 seconds, total timeout 10 seconds, failures collected in the envelope.

`indexes` MUST be sourced from `INFORMATION_SCHEMA.STATISTICS` filtered by `TABLE_SCHEMA = ? AND TABLE_NAME = ?`, with rows grouped by `INDEX_NAME` and columns within each index collected in `SEQ_IN_INDEX` order. Each index entry MUST include `name`, `is_unique` (mapped from `NON_UNIQUE = 0`), `is_primary` (`INDEX_NAME = 'PRIMARY'`), and `columns: Array<{ name, seq_in_index }>`.

`triggers` MUST be sourced from `INFORMATION_SCHEMA.TRIGGERS` filtered by `EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?`. Each trigger entry MUST include `name`, `event_manipulation` (`INSERT`/`UPDATE`/`DELETE`), `action_timing` (`BEFORE`/`AFTER`), and `comment`.

`foreign_keys` MUST be sourced from a join of `INFORMATION_SCHEMA.KEY_COLUMN_USAGE` and `INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS` filtered by `TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`. Each foreign-key entry MUST include `name` (constraint name), `columns: Array<string>`, `referenced_schema`, `referenced_relation`, `referenced_columns: Array<string>`, `update_rule`, and `delete_rule`.

The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "list_table_extras"`, `connection_id: <id>`, `origin: "auto"`, `sql: null`, `params: null`, `metric: { kind: "items", value: <indexes len + triggers len + foreign_keys len, None → 0> }` on success (`null` on outer failure), and `status` matching whether the command itself returned `Ok` or `Err`.

#### Scenario: All three queries succeed for a table with indexes, triggers, and foreign keys

- **WHEN** the table `analytics.events` has 3 indexes, 2 triggers, and 1 foreign key
- **AND** the user invokes `mysql.listTableExtras(id, "analytics", "events")`
- **THEN** the response has `indexes: Some([3 entries])`, `triggers: Some([2 entries])`, `foreign_keys: Some([1 entry])`
- **AND** `failures` is empty

#### Scenario: Per-table scoping excludes other tables' indexes

- **WHEN** schema `app` contains tables `users` (3 indexes) and `orders` (5 indexes)
- **AND** the user invokes `mysql.listTableExtras(id, "app", "users")`
- **THEN** the response includes only the 3 indexes belonging to `users`

#### Scenario: Composite index columns are ordered by SEQ_IN_INDEX

- **WHEN** a composite index `idx_a_b` has columns `(a, b)` with `SEQ_IN_INDEX` 1 and 2
- **THEN** the index entry's `columns` array is `[{ name: "a", seq_in_index: 1 }, { name: "b", seq_in_index: 2 }]` in that exact order

#### Scenario: Primary key index is marked

- **WHEN** the table has a PRIMARY KEY
- **THEN** the corresponding index entry has `name: "PRIMARY"`, `is_primary: true`, and `is_unique: true`

#### Scenario: Foreign key surfaces referenced columns and rules

- **WHEN** the table `orders` has `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT`
- **THEN** the foreign-key entry has `columns: ["user_id"]`, `referenced_relation: "users"`, `referenced_columns: ["id"]`, `update_rule: "RESTRICT"`, `delete_rule: "CASCADE"`

#### Scenario: One sub-query fails, the others surface

- **WHEN** the `INFORMATION_SCHEMA.STATISTICS` query times out at 8 seconds but `TRIGGERS` and `KEY_COLUMN_USAGE` succeed in 200ms
- **THEN** the response has `indexes: None`, `triggers: Some([...])`, `foreign_keys: Some([...])`
- **AND** `failures` contains `{ kind: "indexes", code: "70100", message: "..." }`

#### Scenario: Successful call emits an activity-log entry

- **WHEN** `mysql.listTableExtras` returns 3 indexes, 2 triggers, 1 foreign key
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_table_extras"`, `status: "ok"`, `metric: { kind: "items", value: 6 }`, `origin: "auto"`

### Requirement: Get routine signature command

The MySQL module SHALL expose a Tauri command `mysql_get_routine_signature(id, schema, name, kind)` that returns `{ args_signature: string, return_type: string | null }` for a single routine identified by the tuple `(schema, name, kind)`, where `kind` is `"procedure" | "function"`. Unlike Postgres functions (which have OIDs and support overloading), MySQL routines are uniquely identified by their schema, name, and kind — MySQL does NOT support overloading, so a procedure or function name is unique within a schema. Therefore no OID equivalent is needed and there are no overloads to disambiguate. The command MUST query `INFORMATION_SCHEMA.PARAMETERS` filtered by `(SPECIFIC_SCHEMA, SPECIFIC_NAME, ROUTINE_TYPE)` and assemble `args_signature` from the parameter rows in `ORDINAL_POSITION` order (formatted similarly to `IN name TYPE, OUT name TYPE, INOUT name TYPE`). For functions, `return_type` MUST be populated from the parameter row where `ORDINAL_POSITION = 0` (MySQL's convention for the function return type) or from `INFORMATION_SCHEMA.ROUTINES.DTD_IDENTIFIER`. For procedures, `return_type` MUST be `null`. The command MUST enforce a 5-second timeout. Frontend SHALL invoke this lazily — on hover/tooltip of a routine node or on activation of a routine tab — never proactively for the whole list.

#### Scenario: Returns signature for a stored function

- **WHEN** schema `app` has a function `current_user_id() RETURNS INT`
- **AND** the user invokes `mysql.getRoutineSignature(id, "app", "current_user_id", "function")`
- **THEN** the response is `{ args_signature: "", return_type: "INT" }`

#### Scenario: Returns signature for a stored procedure

- **WHEN** schema `app` has a procedure `recalc_balances(IN user_id INT, OUT total DECIMAL(10,2))`
- **AND** the user invokes `mysql.getRoutineSignature(id, "app", "recalc_balances", "procedure")`
- **THEN** the response is `{ args_signature: "IN user_id INT, OUT total DECIMAL(10,2)", return_type: null }`

#### Scenario: Unknown routine returns NotFound

- **WHEN** the user invokes `mysql.getRoutineSignature` for a `(schema, name, kind)` tuple that does not exist
- **THEN** the command returns `AppError::NotFound`

#### Scenario: Timeout returns 70100

- **WHEN** the catalog lookup exceeds 5 seconds
- **THEN** the command returns `AppError::Mysql` with code `"70100"`

### Requirement: Partial-result envelope contract

Multi-query commands (`mysql_list_structure`, `mysql_list_table_extras`) SHALL return a partial-result envelope where each kind field is `Option<T>` (`None` indicates that kind's sub-query failed) and a `failures: Vec<KindFailure>` collects per-kind failure details. The envelope MUST be serialized to the frontend via `snake_case` JSON keys: `{ "routines": null, "triggers": [...], "events": [...], "failures": [...] }`. A `KindFailure` MUST contain `kind: string`, `code: Option<string>` (MySQL SQLSTATE if MySQL-typed, e.g. `"70100"` for `ER_QUERY_INTERRUPTED`, `"42000"` for general access denied, `"28000"` for connection-level authentication failures), `message: string`. Permission-denied on `INFORMATION_SCHEMA` (SQLSTATE `"42000"` with a SELECT-denied message) MUST NOT enter `failures` — it degrades to an empty payload silently with logging.

#### Scenario: All-success envelope has empty failures

- **WHEN** every sub-query of a multi-query command returns successfully
- **THEN** `failures` is an empty array

#### Scenario: Failure envelope is consumable by frontend

- **WHEN** the response includes `{ "routines": null, "failures": [{ "kind": "routines", "code": "70100", "message": "timed out (8s)" }] }`
- **THEN** the frontend MUST be able to render the structure group with triggers/events populated and a per-kind error indicator next to "Routines"

### Requirement: Lazy on-expand fetching of structure and table extras

The frontend SHALL fetch a schema's `Structure` group only when the user expands it (via `SidebarTree`'s expand toggle). Until expansion, no `mysql_list_structure` IPC SHALL be issued for that schema. Similarly, the frontend SHALL fetch a table's indexes/triggers/foreign keys only when the user expands that table; no `mysql_list_table_extras` SHALL be issued for collapsed tables. The first expansion MUST trigger the fetch; subsequent expand/collapse cycles MUST serve the cached result without re-fetching.

#### Scenario: Collapsed Structure group never fetches

- **WHEN** the user expands a schema and only views the `Data` group
- **THEN** `mysql_list_structure` is NEVER invoked for that schema

#### Scenario: First Structure expand fetches, second does not

- **WHEN** the user expands the `Structure` group of schema `app` for the first time
- **THEN** `mysql.listStructure(id, "app")` is invoked exactly once
- **AND** when the user collapses and re-expands the same group in the same session
- **THEN** the cached payload is rendered and `mysql.listStructure` is not invoked again

#### Scenario: First table expand triggers per-table extras fetch

- **WHEN** the user expands the table `app.users` for the first time
- **THEN** `mysql.listTableExtras(id, "app", "users")` is invoked exactly once
- **AND** other tables' `Indexes`/`Triggers`/`Foreign Keys` are NOT fetched until the user expands them

#### Scenario: Per-table cache is keyed by relation

- **WHEN** the user has expanded `app.users` (causing one `listTableExtras` call)
- **AND** the user expands `app.orders` for the first time
- **THEN** `mysql.listTableExtras` is invoked once more, with `relation: "orders"`
- **AND** re-expanding `app.users` does NOT re-fetch

### Requirement: New SQL Query item in connection-row context menu

The right-click context menu on a MySQL connection row SHALL include a `New SQL Query` item at the top of the menu when the connection is connected. The item MUST:

- Sit above the existing `Edit / Duplicate / Delete` items.
- Be separated from the modification items by a visual separator.
- Open a new `mysql-query` tab against that connection when activated (same handler as the `+ Query` button).
- NOT appear when the connection is disconnected.

#### Scenario: New SQL Query appears for connected connections

- **WHEN** the user right-clicks a connected MySQL connection row
- **THEN** the context menu shows `New SQL Query` as its first item, followed by a separator, then `Edit`, `Duplicate`, `Delete`

#### Scenario: New SQL Query is hidden for disconnected connections

- **WHEN** the user right-clicks a disconnected MySQL connection row
- **THEN** the context menu shows `Edit`, `Duplicate`, `Delete` only — no `New SQL Query` item, no leading separator

#### Scenario: Activating the menu item opens a query tab

- **WHEN** the user right-clicks a connected connection row and selects `New SQL Query`
- **THEN** a new `mysql-query` tab opens against that connection with an empty SQL buffer
- **AND** the editor in that tab takes focus

### Requirement: Context folder integration

The MySQL schema browser SHALL surface context-folder documentation when the connection has a linked folder: a `📄` badge after the label of tree nodes that match a documented relation, a "Docs" subtab in the detail view rendering the parsed object's body and `human:` chips, column-note decoration in the structure subtab, and an unavailability banner above the tree when the folder is in `Unavailable` state. All four surfaces consume the existing shared components from `src/modules/context/components/` and the `useContextObjects` / `useContextObject` hooks.

#### Scenario: Tree shows badge for documented relation

- **WHEN** a MySQL connection is linked to a folder containing `mysql/sales/orders.md`
- **AND** the schema browser renders the `sales` schema's tables
- **THEN** the `orders` node renders a `📄` badge after its label

#### Scenario: Docs subtab visible when relation has doc

- **WHEN** the user selects `sales.orders` in the schema browser
- **AND** the relation has a documented object
- **THEN** the detail view's `SubtabHeader` includes a "Docs" entry
- **AND** activating it renders the `DocsSubtab` with the body and chips

#### Scenario: Docs subtab hidden when no doc

- **WHEN** the user selects a MySQL relation that has no documented object
- **THEN** the detail view's `SubtabHeader` does not include a "Docs" entry

#### Scenario: Column notes decorate structure subtab

- **WHEN** the selected relation has `human.column_notes: { email: "lowercased before insert" }`
- **THEN** the structure subtab's `email` row shows the note string as an inline annotation

#### Scenario: Unavailability banner appears

- **WHEN** a MySQL connection is linked to a folder whose root has been deleted on disk
- **THEN** an unavailability banner is rendered above the schema tree showing the folder path

