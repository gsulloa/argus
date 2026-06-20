# athena-schema-browser Specification

## Purpose
TBD - created by archiving change add-athena-connection. Update Purpose after archive.
## Requirements
### Requirement: List Glue databases

The Athena module SHALL expose a Tauri command `athena_list_databases(connection_id)` that returns the Glue databases in the default data catalog (`AwsDataCatalog`) via `glue:GetDatabases` (paginated). Each entry MUST include at least `{ name }`. The command MUST timeout after a bounded interval.

#### Scenario: Databases listed for the sidebar

- **WHEN** the user expands a connected Athena connection in the sidebar
- **THEN** the command returns the Glue databases for the default catalog, paging through all results

#### Scenario: No databases returns an empty list

- **WHEN** the catalog has no databases the user can see
- **THEN** the command returns an empty list (not an error)

### Requirement: List tables and views for a database

The Athena module SHALL expose `athena_list_relations(connection_id, database)` that returns the tables and views in a Glue database via `glue:GetTables` (paginated). Each relation MUST include `{ name, kind }` where `kind` is `"view"` when the Glue `TableType` is `VIRTUAL_VIEW` and `"table"` otherwise.

#### Scenario: Tables and views distinguished

- **WHEN** the user expands a Glue database that contains both tables and a view
- **THEN** the returned relations mark the `VIRTUAL_VIEW` entry with `kind: "view"` and the others with `kind: "table"`

### Requirement: List columns for a relation

The Athena module SHALL expose column metadata for a relation derived from the Glue table definition: the columns in `StorageDescriptor.Columns` followed by `PartitionKeys`, each as `{ name, ty }` using the Glue column type string. Athena tables have no primary key, so any introspected `primary_key` MUST be empty.

#### Scenario: Columns include partition keys

- **WHEN** the user inspects a partitioned Glue table
- **THEN** the returned columns include both the storage-descriptor columns and the partition keys, in that order

### Requirement: Schema tree and table preview

The Athena sidebar SHALL render, for each connected Athena connection, a tree with a **"Named Queries"** branch (defined by the `athena-named-queries` capability) positioned **above** the Glue databases, followed by the databases tree (databases → tables/views → columns). Expanding a database lazy-loads its relations via `athena_list_relations`; expanding a relation lazy-loads its columns via `athena_list_columns`. Clicking a table or view opens a new Athena query tab pre-filled with `SELECT * FROM "<database>"."<relation>" LIMIT 100`. A manual refresh of the connection SHALL invalidate the cached schema **and** the cached NamedQueries listing for that connection.

#### Scenario: Clicking a table opens a SELECT preview tab

- **WHEN** the user clicks a table node in the schema tree
- **THEN** a new Athena query tab opens pre-filled with `SELECT * FROM "<database>"."<relation>" LIMIT 100`

#### Scenario: Named Queries branch precedes databases

- **WHEN** the user expands a connected Athena connection in the sidebar
- **THEN** the "Named Queries" branch is rendered above the Glue databases
- **AND** the databases → tables → columns behavior is unchanged

#### Scenario: Refresh invalidates both schema and NamedQueries caches

- **WHEN** the user manually refreshes an Athena connection
- **THEN** both the cached schema (databases/relations/columns) and the cached NamedQueries listing for that connection are invalidated and re-fetched on next expand

### Requirement: Completion caches feed editor autocompletion

Expanding the Athena schema tree SHALL populate a global schema cache (databases/tables) and a columns cache for the connection, mirroring the MySQL caches, so the Athena SQL editor offers schema-, table-, and column-name completions. The caches MUST be cleared for a connection when it disconnects (observing the `athena:active-changed` event).

#### Scenario: Editor autocompletes known tables and columns

- **WHEN** the schema tree has been expanded for a connected Athena connection and the user types in the SQL editor
- **THEN** completion offers the cached database, table, and column identifiers for that connection

#### Scenario: Cache cleared on disconnect

- **WHEN** an Athena connection disconnects
- **THEN** the cached schema/column entries for that connection are removed

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

