## ADDED Requirements

### Requirement: Schema tree persists across focus switches with TTL refresh

The Athena schema tree (databases → tables/views → columns) and its backing `athenaSchemaCache` MUST persist in a process-wide store across unmount/remount of the connection's subtree. When the user switches focus away from and back to an Athena connection, the tree MUST render its previously-loaded databases (and any expanded relations/columns) **from cache without re-issuing** `athena_list_relations` or `athena_list_columns`, provided the cached entry is not stale.

Each connection's schema cache entry MUST record a `fetchedAt` timestamp and MUST be considered **stale** when older than `SCHEMA_CACHE_TTL_MS` (1 hour). When an Athena connection is refocused and its entry is stale, the tree MUST render the cached data immediately and refresh the databases listing in the background; on success the cache is replaced and the tree re-renders, on failure the stale data is retained.

A forced reload — the connection's toolbar refresh button or the global `Cmd+R` / `Ctrl+R` accelerator while the Athena connection is focused — MUST invalidate the cached schema **and** the cached NamedQueries listing for that connection (the existing `athena:schema-refresh` path) and re-fetch on next expand, regardless of TTL freshness.

#### Scenario: Refocusing a loaded Athena connection serves cache without refetch

- **WHEN** an Athena connection's databases (and any expanded relations) have loaded and the user switches focus to another connection and then back within the TTL window
- **THEN** the schema tree renders immediately from cache
- **AND** neither `athena_list_relations` nor `athena_list_columns` is re-invoked for the previously-expanded nodes on the refocus

#### Scenario: Stale Athena entry past TTL refreshes in the background

- **WHEN** the user refocuses an Athena connection whose cached schema entry is older than `SCHEMA_CACHE_TTL_MS`
- **THEN** the tree renders the stale cached databases immediately
- **AND** the databases listing is refreshed in the background and the tree re-renders on success

#### Scenario: Cmd+R forces a full reload regardless of freshness

- **WHEN** the user presses `Cmd+R` / `Ctrl+R` while an Athena connection is focused
- **THEN** the cached schema and NamedQueries listing for that connection are invalidated
- **AND** the databases are re-fetched on next expand even if the cached entry was still fresh
