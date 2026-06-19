## MODIFIED Requirements

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
