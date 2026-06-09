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

The frontend SHALL render an Athena schema tree (databases → tables/views → columns) in the connection sidebar, mirroring the MySQL tree. Activating a table/view leaf MUST open a new SQL editor tab pre-filled with `SELECT * FROM "<database>"."<relation>" LIMIT 100` (Athena is read-mostly and `COUNT(*)` incurs scan cost, so no inline-edit data grid is provided in v1). The user runs the preview explicitly so no scan is billed until they choose to run it.

#### Scenario: Clicking a table opens a SELECT preview tab

- **WHEN** the user clicks a table leaf in the Athena tree
- **THEN** a new SQL editor tab opens pre-filled with `SELECT * FROM "<database>"."<relation>" LIMIT 100`
- **AND** no query is executed until the user runs it

### Requirement: Completion caches feed editor autocompletion

Expanding the Athena schema tree SHALL populate a global schema cache (databases/tables) and a columns cache for the connection, mirroring the MySQL caches, so the Athena SQL editor offers schema-, table-, and column-name completions. The caches MUST be cleared for a connection when it disconnects (observing the `athena:active-changed` event).

#### Scenario: Editor autocompletes known tables and columns

- **WHEN** the schema tree has been expanded for a connected Athena connection and the user types in the SQL editor
- **THEN** completion offers the cached database, table, and column identifiers for that connection

#### Scenario: Cache cleared on disconnect

- **WHEN** an Athena connection disconnects
- **THEN** the cached schema/column entries for that connection are removed

