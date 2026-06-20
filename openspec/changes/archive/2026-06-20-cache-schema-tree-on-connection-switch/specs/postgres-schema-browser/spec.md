## MODIFIED Requirements

### Requirement: Schema cache and invalidation

The frontend SHALL cache schema-browser data in a **process-wide** store keyed by `(connectionId, schema)` with sub-keys for each lazy group. The per-schema cache MUST hold three independent slots: `relations` (eager), `structure` (lazy), and a `Map<relation, tableExtras>` (lazy per-table). Each slot MUST be populated on first need and MUST be served on subsequent reads without re-fetching.

The cache MUST survive unmount/remount of the connection's subtree. On mount, `useSchemaTree` MUST seed its local state machine from the process-wide cache: if a non-stale schemas entry exists for the connection, the tree MUST initialize to a loaded state (and seed any cached `relations` slots as loaded) **without** issuing `postgres.listSchemas` or `postgres.listRelations`. Switching focus away from and back to a connection MUST NOT, by itself, drop the cache or trigger a refetch.

Each connection's schemas-level cache entry MUST record a `fetchedAt` timestamp. An entry is **stale** when it is older than the TTL (`SCHEMA_CACHE_TTL_MS`, 1 hour). When a connection is mounted (e.g. refocused) and its entry is stale, the tree MUST render the cached data immediately and refresh in the background (`postgres.listSchemas` followed by eager `postgres.listRelations` for visible schemas); on success the cache is replaced and the tree re-renders; on failure the stale data is retained.

The cache MUST be invalidated for an entire connection when (a) the user invokes `Schema: Refresh` from the palette, the connection row's refresh button, or the global `Cmd+R` / `Ctrl+R` accelerator while the connection is focused, or (b) a `postgres:active-changed` event reports the connection as no longer active. Individual group slots MAY be invalidated independently when the user activates an inline retry button on a failed group. The cache MUST NOT be persisted to disk.

#### Scenario: First relations expand fetches; second does not

- **WHEN** the user makes schema `public` visible for the first time in a session
- **THEN** the command `postgres.listRelations(id, "public")` is invoked exactly once
- **AND** when the schema is hidden via the picker and re-shown in the same session
- **THEN** the cached payload is rendered and `postgres.listRelations` is not invoked again

#### Scenario: Group cache slots are independent

- **WHEN** the `relations` slot has loaded successfully and the `structure` slot is in error state
- **AND** the user activates the inline retry button on the `structure` group
- **THEN** only `postgres.listStructure` is re-invoked; the relations slot is not touched

#### Scenario: Refocusing a loaded connection serves cache without refetch

- **WHEN** a connection's schemas (and visible-schema relations) have loaded and the user switches focus to another connection in the rail and then back within the TTL window
- **THEN** the schema tree renders immediately from the cache
- **AND** neither `postgres.listSchemas` nor `postgres.listRelations` is invoked again on the refocus

#### Scenario: Stale entry past TTL refreshes in the background

- **WHEN** the user refocuses a connection whose cached schemas entry is older than `SCHEMA_CACHE_TTL_MS`
- **THEN** the tree renders the stale cached data immediately
- **AND** `postgres.listSchemas` is re-invoked in the background and the tree re-renders on success without an intervening blank/loading state

#### Scenario: Refresh palette command clears the connection's full cache

- **WHEN** the user runs `Schema: Refresh` from the palette while focused on a connection
- **THEN** every cached entry for that connection is dropped — `relations`, `structure`, and per-table `tableExtras` for every schema
- **AND** the next visibility/expand of any group re-invokes the corresponding command

#### Scenario: Disconnect drops the cache

- **WHEN** the user disconnects a connection
- **THEN** every cached entry for that connection id is dropped
- **AND** if the user reconnects and re-views a schema, the relevant commands are invoked
