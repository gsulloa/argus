# context-query-authoring Specification

## Purpose
TBD - created by archiving change saved-queries-in-context. Update Purpose after archive.
## Requirements
### Requirement: Save a query into a connection's context folder

The platform SHALL expose `context_save_query({ connection_id: string, name: string, sql: string, description?: string, params?: QueryParam[], tags?: string[] })` that persists a prefab query into the connection's linked context folder. The command MUST:

- Resolve the connection's canonical `context_path` and its engine subtree (`postgres`/`mysql`/`mssql`/`dynamo`/`cloudwatch`); if the connection has no linked context folder, return a structured error `NoContextFolder` and write nothing.
- Derive a deterministic, filesystem-safe `slug` from the trimmed `name` (reject an empty trimmed `name`).
- Write the body file `<root>/<engine>/queries/<slug>.<ext>` (`ext` = `sql` for Postgres/MySQL/MSSQL, `partiql` for Dynamo, `cwlogs` for CloudWatch) and the sibling `<root>/<engine>/queries/<slug>.meta.yaml` carrying `{ name, description, params, tags }`, creating the `queries/` directory if absent.
- Return the saved `QueryDoc` (without exposing the absolute `source_path` over IPC beyond existing conventions).
- Never write connection credentials or secrets — only SQL text and metadata.

#### Scenario: Save creates body and meta files under the engine subtree

- **WHEN** a Postgres connection linked to `/repo/ctx` invokes `context_save_query({ connection_id, name: "Top customers", sql: "SELECT 1" })`
- **THEN** `/repo/ctx/postgres/queries/top-customers.sql` is written with body `SELECT 1`
- **AND** `/repo/ctx/postgres/queries/top-customers.meta.yaml` is written with `name: "Top customers"`
- **AND** the command returns a `QueryDoc` whose `name` is `"Top customers"` and `body` is `SELECT 1`

#### Scenario: Save without a linked context folder is rejected

- **WHEN** a connection with `context_path = null` invokes `context_save_query`
- **THEN** the command returns `NoContextFolder` and no files are written

#### Scenario: Empty name is rejected

- **WHEN** `context_save_query` is invoked with a `name` that is empty after trimming
- **THEN** the command returns a validation error and no files are written

#### Scenario: Engine-appropriate extension is used

- **WHEN** a Dynamo connection invokes `context_save_query({ name: "recent", sql: "SELECT * FROM ..." })`
- **THEN** the body file is written as `dynamo/queries/recent.partiql`

### Requirement: Creating a query with a colliding name is a conflict; updating overwrites

`context_save_query` MUST distinguish create from update. When invoked in create mode and a body file already exists for the derived `slug`, the command SHALL return a structured `Conflict` error and leave the existing files untouched. When invoked in update mode for an existing query of the same `slug`, the command SHALL overwrite the body and meta files in place.

#### Scenario: Create over an existing slug returns Conflict

- **WHEN** `postgres/queries/top-customers.sql` already exists and the user creates another query whose name derives to `top-customers`
- **THEN** the command returns `Conflict` and the existing files are unchanged

#### Scenario: Update overwrites the same files

- **WHEN** the user updates an existing context query `top-customers` with new `sql`
- **THEN** `postgres/queries/top-customers.sql` is overwritten with the new body and `top-customers.meta.yaml` is updated

### Requirement: Rename a context query

The platform SHALL expose `context_rename_query({ connection_id: string, from_name: string, to_name: string })` that renames both sibling files (`<old-slug>.<ext>` → `<new-slug>.<ext>` and the corresponding `.meta.yaml`) and updates the `name` field inside the meta file. The command MUST reject (return `Conflict`) if a query already exists at the target slug, and reject (`NotFound`) if no query exists at `from_name`.

#### Scenario: Rename moves both files and updates meta name

- **WHEN** the user renames context query `top-customers` to `Best customers`
- **THEN** `postgres/queries/top-customers.sql` and `.meta.yaml` are renamed to `best-customers.sql` and `best-customers.meta.yaml`
- **AND** the meta file's `name` becomes `"Best customers"`

#### Scenario: Rename onto an existing query is a conflict

- **WHEN** both `top-customers` and `best-customers` already exist and the user renames `top-customers` to `Best customers`
- **THEN** the command returns `Conflict` and no files are changed

### Requirement: Delete a context query

The platform SHALL expose `context_delete_query({ connection_id: string, name: string })` that removes the body file and its sibling `.meta.yaml` from the connection's context folder. Deleting a non-existent query SHALL return `NotFound`.

#### Scenario: Delete removes both sibling files

- **WHEN** the user deletes context query `top-customers`
- **THEN** `postgres/queries/top-customers.sql` and `postgres/queries/top-customers.meta.yaml` are removed from disk

### Requirement: Authoring changes propagate through the context watcher

After a successful `context_save_query`, `context_rename_query`, or `context_delete_query`, the platform SHALL cause a `context://changed` event whose `kinds` include `"query"` for the affected folder path to be emitted, so any UI subscribed to that folder refreshes its query list without a manual reload.

#### Scenario: Saving a query refreshes subscribers

- **WHEN** a query is saved into a folder that has active subscribers
- **THEN** a `context://changed` event with `kinds` including `"query"` is emitted for that folder path
- **AND** the Saved Queries panel and any per-connection Context Queries branch for that folder show the new query without a manual reload

