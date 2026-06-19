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

