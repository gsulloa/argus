## ADDED Requirements

### Requirement: List tables command

The Dynamo module SHALL expose a Tauri command `dynamo.listTables(connectionId, { paginationToken?: string, cap?: number }) -> { tables: string[], nextToken?: string, truncated: boolean }`. The command MUST look up the active client in `DynamoClientRegistry` and MUST return `AppError::NotFound` if no client is registered for `connectionId`. The command MUST issue AWS `ListTables` calls with `Limit: 100` and follow `LastEvaluatedTableName` internally, concatenating returned `TableNames` until either AWS reports no further `LastEvaluatedTableName` or the accumulated count reaches `cap`. The default `cap` is 1000 (overridable per call and per connection via setting `dynamoTablesCap:<connectionId>`). When the cap is reached and AWS still has more tables, the returned `truncated` MUST be `true` and `nextToken` MUST be the last seen `LastEvaluatedTableName` so callers can resume. When all tables fit under the cap, `truncated` MUST be `false` and `nextToken` MUST be omitted. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "list_tables"`, `connection_id: <id>`, `origin: "auto" | "user"`, `sql: null`, `params: null`, `metric: { kind: "items", value: tables.length }` on success (`null` on failure), `status` matching the result, and `duration_ms` covering the whole command including internal pagination.

#### Scenario: Single page result under cap

- **WHEN** the user invokes `dynamo.listTables(id, {})` for an active connection in a region with 42 tables
- **THEN** the command returns `{ tables: [...42 names...], truncated: false }` with no `nextToken`
- **AND** AWS `ListTables` was invoked exactly once internally

#### Scenario: Multi-page result under cap

- **WHEN** the user invokes `dynamo.listTables(id, {})` for an active connection in a region with 250 tables
- **THEN** AWS `ListTables` is invoked 3 times internally (100 + 100 + 50)
- **AND** the command returns `{ tables: [...250 names...], truncated: false }` with no `nextToken`

#### Scenario: Cap reached, truncated true

- **WHEN** the user invokes `dynamo.listTables(id, {})` for a connection in a region with 1500 tables and the cap is the default 1000
- **THEN** the command returns `{ tables: [...1000 names...], truncated: true, nextToken: <last seen LastEvaluatedTableName> }`
- **AND** the user can resume by invoking `dynamo.listTables(id, { paginationToken: nextToken })`

#### Scenario: Resume from pagination token

- **WHEN** the user invokes `dynamo.listTables(id, { paginationToken: "tbl-999" })`
- **THEN** internal AWS calls use `ExclusiveStartTableName: "tbl-999"` for the first request
- **AND** subsequent pages follow normally

#### Scenario: Per-call cap overrides default

- **WHEN** the user invokes `dynamo.listTables(id, { cap: 50 })` for a connection in a region with 100 tables
- **THEN** the command returns at most 50 tables with `truncated: true` and a `nextToken`

#### Scenario: No active client

- **WHEN** the user invokes `dynamo.listTables(id, {})` for a `connectionId` not present in `DynamoClientRegistry`
- **THEN** the command returns `AppError::NotFound`
- **AND** no AWS API call is made

#### Scenario: Expired access-keys session token triggers re-prompt

- **WHEN** `dynamo.listTables` fails with `ExpiredToken` on a connection in access-keys mode with a session token
- **THEN** the command returns `AppError::Aws` with the matching code
- **AND** the Dynamo module marks `params.needs_credentials = true` and evicts the client per the existing credential-expiration contract

#### Scenario: Successful call emits activity-log

- **WHEN** `dynamo.listTables` returns 42 tables
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_tables"`, `status: "ok"`, `metric: { kind: "items", value: 42 }`, `connection_id: <id>`

#### Scenario: Failure emits activity-log with status err

- **WHEN** `dynamo.listTables` fails because the registry has no client for the id
- **THEN** one `argus:activity-log` event is emitted with `kind: "list_tables"`, `status: "err"`, `metric: null`

### Requirement: Describe table command

The Dynamo module SHALL expose a Tauri command `dynamo.describeTable(connectionId, tableName) -> TableDescription` that returns a typed envelope with the following snake_case fields: `table_name`, `table_arn`, `table_status` (one of `"ACTIVE" | "CREATING" | "UPDATING" | "DELETING" | "INACCESSIBLE_ENCRYPTION_CREDENTIALS" | "ARCHIVING" | "ARCHIVED"`), `creation_date_time` (ISO 8601), `item_count` (u64), `table_size_bytes` (u64), `billing_mode` (`"PROVISIONED" | "PAY_PER_REQUEST"`), `key_schema` (`Array<{ attribute_name: string, key_type: "HASH" | "RANGE" }>`), `attribute_definitions` (`Array<{ attribute_name: string, attribute_type: "S" | "N" | "B" }>`), `global_secondary_indexes` (`Array<GsiInfo>`), `local_secondary_indexes` (`Array<LsiInfo>`), `stream_specification` (`{ stream_enabled: bool, stream_view_type?: string } | null`). `GsiInfo` MUST include `index_name`, `key_schema`, `projection_type`, `index_status`, and `provisioned_throughput` when applicable. `LsiInfo` MUST include `index_name`, `key_schema`, `projection_type`. The command MUST look up the active client in `DynamoClientRegistry` and MUST return `AppError::NotFound` if no client is registered for `connectionId`. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "describe_table"`, `connection_id: <id>`, `origin: "auto" | "user"`, `sql: null`, `params: null`, `metric: { kind: "items", value: 1 }` on success (`null` on failure), `status` matching the result, and `duration_ms`.

#### Scenario: Describe an active on-demand table with one GSI

- **WHEN** the user invokes `dynamo.describeTable(id, "events")` for an `ACTIVE` table with `BillingMode: PAY_PER_REQUEST`, a HASH key `pk`, RANGE key `sk`, one GSI named `byCustomer`
- **THEN** the response includes `billing_mode: "PAY_PER_REQUEST"`, `table_status: "ACTIVE"`, two entries in `key_schema`, one entry in `global_secondary_indexes` with `index_name: "byCustomer"`

#### Scenario: Describe table with no streams

- **WHEN** the described table has streams disabled
- **THEN** `stream_specification` is `null`

#### Scenario: Describe table with streams enabled

- **WHEN** the described table has streams enabled with `NEW_AND_OLD_IMAGES`
- **THEN** `stream_specification` is `{ stream_enabled: true, stream_view_type: "NEW_AND_OLD_IMAGES" }`

#### Scenario: Table not found in AWS

- **WHEN** the user invokes `dynamo.describeTable(id, "no-such-table")` for an active connection whose region does not have that table
- **THEN** the command returns `AppError::Aws` with code `"ResourceNotFoundException"`

#### Scenario: No active client

- **WHEN** the user invokes `dynamo.describeTable(id, "events")` for a `connectionId` with no registered client
- **THEN** the command returns `AppError::NotFound` and no AWS API call is made

#### Scenario: Successful describe emits activity-log

- **WHEN** `dynamo.describeTable` succeeds
- **THEN** one `argus:activity-log` event is emitted with `kind: "describe_table"`, `status: "ok"`, `metric: { kind: "items", value: 1 }`, `connection_id: <id>`

### Requirement: Frontend table cache

The frontend SHALL maintain an in-memory cache per Dynamo connection holding two slots: a `tables` slot (state machine `{ status: "idle" | "loading" | "ready" | "error", names?: string[], nextToken?: string, truncated?: boolean, error?: AppError }`) and a `describe` slot (a `Map<tableName, { status: "loading" | "ready" | "error", value?: TableDescription, error?: AppError }>`). The cache MUST be created on first mount of the connection's subtree and MUST be dropped when (a) the user invokes `Tables: Refresh` for the connection, (b) the connection appears in `dynamo:active-changed` as no longer active, or (c) `dynamo:credentials-refreshed` fires for the connection. The cache MUST NOT be persisted to disk.

#### Scenario: First mount triggers listTables once

- **WHEN** the user connects a Dynamo connection and its subtree mounts for the first time in the session
- **THEN** `dynamo.listTables(id, {})` is invoked exactly once
- **AND** while the call is in flight the cache's `tables` slot has `status: "loading"`

#### Scenario: Re-mount uses cache, no new listTables call

- **WHEN** the cache for a connection has `tables.status: "ready"` and the subtree is unmounted (e.g. user collapses the connection row) and then re-mounted
- **THEN** `dynamo.listTables` is NOT invoked again
- **AND** the rendered list reflects the cached names

#### Scenario: Disconnect drops the cache

- **WHEN** a connected Dynamo connection is disconnected
- **THEN** every cache entry for that connection id is dropped from memory
- **AND** if the user reconnects, `dynamo.listTables` is invoked again on the next subtree mount

#### Scenario: Credentials refresh drops the cache

- **WHEN** `dynamo:credentials-refreshed` fires for an active connection
- **THEN** the cache for that connection id is dropped
- **AND** if the subtree is currently mounted, `dynamo.listTables` is re-invoked automatically

#### Scenario: Cache is per-connection

- **WHEN** the user has two connected Dynamo connections A and B and refreshes A
- **THEN** A's cache is dropped and re-fetched
- **AND** B's cache is untouched

### Requirement: Sidebar table subtree under each active Dynamo connection

The frontend SHALL render a single-level subtree directly underneath each active Dynamo connection row in the sidebar. The subtree MUST consume the platform's `SidebarTree` primitive at depth 1 (no intermediate group nodes). The subtree MUST NOT be rendered when the connection is inactive. Each leaf node MUST render the table name and three optional indicators (see "Per-table indicators on each leaf"). Activation of a leaf node (Enter key, single click, or double click — equivalent) MUST open or focus a tab as defined in "Activating a table node opens a placeholder tab".

#### Scenario: Subtree appears on connect

- **WHEN** the user clicks an inactive Dynamo connection row and the connect succeeds
- **THEN** a subtree appears under that row containing one leaf per table returned by `dynamo.listTables`

#### Scenario: Subtree disappears on disconnect

- **WHEN** the user disconnects an active Dynamo connection
- **THEN** the subtree under that row is removed from the sidebar

#### Scenario: Subtree has no intermediate nodes

- **WHEN** the subtree is rendered with N tables
- **THEN** the tree has depth 1 — every node is a leaf representing a table
- **AND** there are no group nodes such as "Tables" or "Schema"

#### Scenario: Subtree shares the sidebar scroll context

- **WHEN** the subtree contains more rows than fit in the sidebar viewport
- **THEN** scrolling the sidebar moves through the subtree as part of the single sidebar scroll context
- **AND** no independent scrollbar appears inside the subtree

#### Scenario: Virtualization above threshold

- **WHEN** the subtree has more than 500 visible leaf nodes after the search filter is applied
- **THEN** the `SidebarTree` virtualizer is engaged for that subtree

### Requirement: Per-table indicators on each leaf

Each table leaf node in the subtree SHALL render up to three indicators to the right of the table name once the describe for that table has loaded: a billing-mode badge (`on-demand` when `billing_mode === "PAY_PER_REQUEST"`, `provisioned` otherwise), a streams icon-badge when `stream_specification?.stream_enabled` is `true` (with tooltip `Streams enabled · <stream_view_type>`), and a `GSI×N` text badge when `global_secondary_indexes.length > 0` (where `N` is that length). When the describe has not yet loaded, a thin fixed-width placeholder MUST occupy the indicator slot to prevent layout shift. When `table_status !== "ACTIVE"`, the node MUST render an additional status badge displaying the literal status string in a warning tone.

#### Scenario: On-demand table without streams or GSIs

- **WHEN** a describe arrives with `billing_mode: "PAY_PER_REQUEST"`, no streams, zero GSIs
- **THEN** the node renders the `on-demand` badge only

#### Scenario: Provisioned table with streams and GSIs

- **WHEN** a describe arrives with `billing_mode: "PROVISIONED"`, streams enabled with `NEW_IMAGE`, three GSIs
- **THEN** the node renders `provisioned`, the streams icon (with tooltip `Streams enabled · NEW_IMAGE`), and `GSI×3`

#### Scenario: Loading placeholder before describe

- **WHEN** the table name is rendered but its describe is still loading
- **THEN** the indicator slot shows a fixed-width placeholder shimmer
- **AND** when the describe completes, the badges appear without shifting the node's name position

#### Scenario: Non-ACTIVE status badge

- **WHEN** the describe arrives with `table_status: "UPDATING"`
- **THEN** the node renders an additional badge displaying `UPDATING` in a warning tone

#### Scenario: Zero GSIs does not render a badge

- **WHEN** a describe has `global_secondary_indexes.length === 0`
- **THEN** no `GSI×0` badge appears (the slot is omitted)

### Requirement: Lazy describe pipeline

The frontend SHALL dispatch `dynamo.describeTable` calls lazily, only for table names currently rendered (or imminently rendered via virtualizer look-ahead) in the subtree's viewport. The dispatcher MUST cap in-flight describes to 8 simultaneous per connection. As nodes scroll out of view, in-flight describes for off-viewport names MAY continue to completion but new describes MUST NOT be queued for off-viewport names. Each table name MUST be described at most once per cache lifetime (subsequent visibility uses the cached describe). On describe failure for a specific table, the node MUST render an inline error indicator with a `Retry` affordance that re-fires the describe for that name only.

#### Scenario: Initial mount describes visible names only

- **WHEN** the subtree mounts with 200 table names of which 20 are in the initial viewport
- **THEN** at most 20 `dynamo.describeTable` calls are queued initially
- **AND** at most 8 are in flight at any moment

#### Scenario: Scrolling triggers further describes

- **WHEN** the user scrolls the sidebar and new table nodes enter the viewport
- **THEN** describes are queued for the newly visible names (subject to the parallelism cap)
- **AND** names that were already described are not re-described

#### Scenario: Describe failure shows inline retry

- **WHEN** `dynamo.describeTable(id, "broken")` fails with `ThrottlingException`
- **THEN** the node for `broken` renders an inline error indicator with a `Retry` affordance
- **AND** the indicator-slot placeholder is replaced by the error indicator

#### Scenario: Manual retry re-fires describe for one table

- **WHEN** the user clicks the `Retry` indicator on a node whose describe failed
- **THEN** `dynamo.describeTable(id, name)` is invoked exactly once for that name
- **AND** other nodes are not touched

#### Scenario: Off-viewport names are not described

- **WHEN** the subtree contains 1000 table names but only the first 30 are in the viewport
- **THEN** describes are queued only for those 30 (plus a small virtualizer look-ahead, bounded)
- **AND** no describe is queued for names that are beyond the look-ahead window

### Requirement: Local table search filter

The subtree SHALL render a search input above the leaf nodes. The input MUST filter visible leaves by case-insensitive substring match against the table name. Non-matching leaves MUST be hidden; the matching substring within each visible leaf's name MUST be visually highlighted. The search MUST NOT trigger any AWS API call. Pressing `Escape` while the search input is focused MUST clear the input. The current search text MAY be mirrored to the setting `dynamoTablesSearch:<connectionId>` so that re-mounting the same connection's subtree restores the last-used filter, but persistence is best-effort and MUST NOT block rendering.

#### Scenario: Substring filters loaded names

- **WHEN** the subtree has loaded 50 table names and the user types `evt` into the search input
- **THEN** only leaves whose names contain `evt` (case-insensitive) remain visible
- **AND** the matching substring is highlighted in each visible leaf

#### Scenario: Search does not trigger network

- **WHEN** the user types in the search input
- **THEN** no `dynamo.listTables` or `dynamo.describeTable` call is dispatched as a result

#### Scenario: Escape clears the search

- **WHEN** the search input is focused with text `evt` and the user presses Escape
- **THEN** the input clears and every leaf becomes visible again

#### Scenario: Empty match shows a hint

- **WHEN** the search input matches zero loaded names
- **THEN** an inline "No tables match" hint is rendered in place of the leaf list

#### Scenario: Match indicator shows counts

- **WHEN** the search filters 7 visible leaves out of 50 loaded names
- **THEN** the search input displays an inline indicator "7 of 50"

### Requirement: Truncated result load-more affordance

When the `tables` cache slot has `truncated: true`, the subtree SHALL render a non-leaf "Showing first N of more — Load more" row at the bottom of the leaf list. Activating that row MUST invoke `dynamo.listTables(id, { paginationToken: <cached nextToken>, cap: <same cap as initial call> })` and append the result to the cached names, updating `truncated` and `nextToken` from the response. If the follow-up also returns `truncated: true`, the affordance MUST remain visible.

#### Scenario: Truncated initial result shows load-more

- **WHEN** the initial `dynamo.listTables` returns `truncated: true` with 1000 names
- **THEN** the subtree renders 1000 leaves followed by a "Showing first 1000 of more — Load more" row

#### Scenario: Activating load-more appends

- **WHEN** the user activates the load-more row and the follow-up call returns 800 more names with `truncated: false`
- **THEN** the subtree now shows 1800 leaves and the load-more row is removed

#### Scenario: Repeated truncation keeps load-more visible

- **WHEN** the user activates load-more and the follow-up call returns 1000 more names with `truncated: true`
- **THEN** the subtree shows 2000 leaves and the load-more row remains, ready to fetch the next batch

### Requirement: Activating a table node opens a placeholder tab

The frontend SHALL respond to activation (Enter, single click, or double click — equivalent) on any table leaf by opening or focusing a center-area tab of `kind: "dynamo-table-placeholder"` with payload `{ connectionId, connectionName, tableName, describe }` and stable id `dynamotbl:<connectionId>:<tableName>`. The payload's `describe` field MUST be the cached `TableDescription` for that table, or `null` if the describe has not yet loaded. When opened with a `null` describe, the placeholder tab MUST fire `dynamo.describeTable` itself and render the result on arrival. Activating the same leaf a second time MUST focus the existing tab; it MUST NOT open a duplicate. The placeholder tab body renders a read-only inspection view (key schema, attribute definitions, GSIs/LSIs, billing mode, stream state, item count, ARN) and a "Refresh metadata" button that re-fires `dynamo.describeTable` for that one table. The placeholder tab MUST NOT offer scan/query/edit affordances — those land in changes #11 and #12.

#### Scenario: Click opens the placeholder tab

- **WHEN** the user activates the leaf for `events`
- **THEN** a tab with id `dynamotbl:<connectionId>:events` and kind `dynamo-table-placeholder` opens
- **AND** the tab payload includes `tableName: "events"` and the cached `describe`

#### Scenario: Activating the same leaf twice focuses the existing tab

- **WHEN** the user activates the same leaf a second time
- **THEN** the existing tab is focused; a new tab is NOT opened

#### Scenario: Open with no cached describe fetches on mount

- **WHEN** the user activates a leaf whose describe has not yet completed
- **THEN** the placeholder tab opens with a loading state and invokes `dynamo.describeTable(id, tableName)`
- **AND** when the call returns, the tab body renders the metadata

#### Scenario: Refresh button re-fires describe

- **WHEN** the user clicks "Refresh metadata" in an open placeholder tab
- **THEN** `dynamo.describeTable(id, tableName)` is invoked once and the body updates with the new result

### Requirement: Right-click context menu on a table leaf

Right-clicking a table leaf SHALL open a context menu with three items in this order: `Open` (equivalent to activation), `Copy table name` (copies `tableName` to the clipboard), `Copy ARN` (copies the table ARN to the clipboard). `Copy ARN` MUST prefer the cached `describe.tableArn` when available; if the describe has not loaded, `Copy ARN` MUST reconstruct the ARN locally from the connection's `region` and `accountId` (both available from the active client envelope) and the leaf's `tableName`, using the format `arn:aws:dynamodb:<region>:<accountId>:table/<tableName>`.

#### Scenario: Open item is equivalent to activation

- **WHEN** the user right-clicks a leaf and chooses `Open`
- **THEN** the same placeholder tab opens or is focused as a click would have done

#### Scenario: Copy table name

- **WHEN** the user chooses `Copy table name` from the menu for the leaf `events`
- **THEN** the clipboard contains the literal string `events`

#### Scenario: Copy ARN with cached describe

- **WHEN** the user chooses `Copy ARN` for a leaf whose describe is cached with `table_arn: "arn:aws:dynamodb:us-east-1:123456789012:table/events"`
- **THEN** the clipboard contains exactly that ARN

#### Scenario: Copy ARN without cached describe reconstructs locally

- **WHEN** the user chooses `Copy ARN` for a leaf whose describe is not yet loaded, in a connection with `region: "eu-west-1"` and `accountId: "999988887777"`, for the leaf `orders`
- **THEN** the clipboard contains `arn:aws:dynamodb:eu-west-1:999988887777:table/orders`

### Requirement: Connection row refresh and toolbar affordances

Each active Dynamo connection row SHALL render a refresh icon button in its toolbar slot, visible while the connection is active. Activating the button MUST drop the connection's frontend cache and re-fire `dynamo.listTables` for that connection. The activity-log event for the resulting `dynamo.listTables` call MUST carry `origin: "user"`. The refresh icon MUST follow the existing sidebar icon convention (hover-only visibility is acceptable; muted tone, not the accent color).

#### Scenario: Refresh drops the cache and re-fetches

- **WHEN** the user clicks the refresh icon on an active Dynamo connection row
- **THEN** the cache for that connection id is dropped
- **AND** `dynamo.listTables(id, {})` is invoked exactly once with the activity-log `origin: "user"`

#### Scenario: Refresh on disconnected connection is not available

- **WHEN** a Dynamo connection is disconnected
- **THEN** its row does NOT render a refresh icon

### Requirement: Palette commands for table browsing

The Dynamo module SHALL register palette commands using the existing `command-palette` registry (no platform-level palette changes). Two kinds of commands are registered:

- A static command `Tables: Refresh` (group `"Tables"`) — drops the focused connection's table cache and re-fires `dynamo.listTables` with activity-log `origin: "user"`. When no Dynamo connection is focused, the command's `run` MUST present a chooser (palette stays open via `keepOpen: true` and lists currently connected Dynamo connections; selecting one runs the refresh).
- A **dynamic command per cached table**: for every table name in every connected Dynamo connection's populated cache, a `Command` is registered with `id: "argus.dynamo.openTable:<connectionId>:<tableName>"`, `group: "Tables"`, `label: "<connectionName> · <tableName>"`, `keywords: [connectionName, tableName, "dynamo"]`, and `run` opening or focusing the placeholder tab for that connection+table. These commands MUST be registered when the cache transitions to `status: "ready"` (or grows via load-more) and MUST be unregistered when the cache is dropped (disconnect, refresh, credentials refresh). The palette's existing fuzzy keyword search filters the registered commands as the user types — no typed-prefix mode is introduced.

The module MUST NOT trigger `dynamo.listTables` from the palette for connections whose cache is not yet populated; uncached connections simply contribute no `Tables` entries.

#### Scenario: Refresh palette command on focused connection

- **WHEN** the user has a Dynamo connection focused and runs `Tables: Refresh`
- **THEN** that connection's cache is dropped and `dynamo.listTables` is re-invoked

#### Scenario: Refresh palette command without focus

- **WHEN** the user runs `Tables: Refresh` with no Dynamo connection focused
- **THEN** the palette stays open and presents a chooser listing currently connected Dynamo connections; selecting one runs the refresh

#### Scenario: Cached tables appear as palette commands

- **WHEN** a Dynamo connection `prod-dynamo` has a populated cache containing tables `events` and `orders`
- **THEN** the palette lists two commands in the `Tables` group: `prod-dynamo · events` and `prod-dynamo · orders`

#### Scenario: Typing filters the registered table commands

- **WHEN** the user opens the palette and types `evt`
- **THEN** the palette's existing fuzzy match shows the `Tables`-group entries whose label or keywords contain `evt` (e.g. `prod-dynamo · events`)
- **AND** entries that do not match are filtered out

#### Scenario: Palette does not background-load uncached connections

- **WHEN** a connected Dynamo connection has no cache populated
- **THEN** that connection contributes no `Tables` entries to the palette
- **AND** no `dynamo.listTables` call is made on behalf of the palette

#### Scenario: Cache drop unregisters the corresponding commands

- **WHEN** the user disconnects `prod-dynamo` (or its cache is dropped via refresh / credentials refresh)
- **THEN** every `argus.dynamo.openTable:<prod-dynamo-id>:*` command is unregistered from the palette
- **AND** the palette no longer shows those entries

#### Scenario: Activating a palette entry opens the placeholder tab

- **WHEN** the user activates `prod-dynamo · events` in the palette
- **THEN** the placeholder tab for `events` on connection `prod-dynamo` opens or is focused
