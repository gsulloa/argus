## MODIFIED Requirements

### Requirement: Save a query into a connection's context folder

The platform SHALL expose `context_save_query({ connection_id: string, name: string, sql: string, folder?: string, description?: string, params?: QueryParam[], tags?: string[], mode?: "create" | "update" })` that persists a prefab query into the connection's linked context folder, optionally inside a subfolder. The command MUST:

- Resolve the connection's canonical `context_path` and its engine subtree (`postgres`/`mysql`/`mssql`/`dynamo`/`cloudwatch`); if the connection has no linked context folder, return a structured error `NoContextFolder` and write nothing.
- Derive a deterministic, filesystem-safe `slug` from the trimmed `name` (reject an empty trimmed `name`).
- Interpret `folder` (default empty) as a **relative POSIX subpath** under `queries/`. The command MUST reject any `folder` that is absolute, contains a `..` segment, or is otherwise not contained within `queries/`; each segment MUST be normalized to a filesystem-safe form.
- Write the body file `<root>/<engine>/queries/<folder>/<slug>.<ext>` (`ext` = `sql` for Postgres/MySQL/MSSQL, `partiql` for Dynamo, `cwlogs` for CloudWatch) and the sibling `<folder>/<slug>.meta.yaml` carrying `{ name, description, params, tags }`, creating the `queries/` directory and any intermediate subfolders if absent.
- Return the saved `QueryDoc` including its relative `path` (POSIX, without extension) — e.g. `reports/top-customers` — without exposing the absolute `source_path` over IPC beyond existing conventions.
- Never write connection credentials or secrets — only SQL text and metadata.

#### Scenario: Save at the root of queries/

- **WHEN** a Postgres connection linked to `/repo/ctx` invokes `context_save_query({ connection_id, name: "Top customers", sql: "SELECT 1" })`
- **THEN** `/repo/ctx/postgres/queries/top-customers.sql` and `top-customers.meta.yaml` are written
- **AND** the returned `QueryDoc` has `path` `"top-customers"` and `folder` `""`

#### Scenario: Save into a subfolder

- **WHEN** the connection invokes `context_save_query({ connection_id, name: "Top customers", sql: "SELECT 1", folder: "reports" })`
- **THEN** `/repo/ctx/postgres/queries/reports/top-customers.sql` (+ `.meta.yaml`) are written, creating `queries/reports/` if absent
- **AND** the returned `QueryDoc` has `path` `"reports/top-customers"` and `folder` `"reports"`

#### Scenario: Unsafe folder path is rejected

- **WHEN** `context_save_query` is invoked with `folder: "../escape"` or an absolute path
- **THEN** the command returns a validation error and no files are written

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

`context_save_query` MUST distinguish create from update. Collision is evaluated **per relative path** (`<folder>/<slug>`), so identical slugs in different folders do not collide. When invoked in create mode and a body file already exists at the derived path, the command SHALL return a structured `Conflict` error and leave the existing files untouched. When invoked in update mode for an existing query at the same path, the command SHALL overwrite the body and meta files in place.

#### Scenario: Create over an existing path returns Conflict

- **WHEN** `postgres/queries/reports/top-customers.sql` already exists and the user creates another query deriving to `reports/top-customers`
- **THEN** the command returns `Conflict` and the existing files are unchanged

#### Scenario: Same slug in different folders does not collide

- **WHEN** `postgres/queries/daily/summary.sql` exists and the user creates a query named `summary` with `folder: "weekly"`
- **THEN** `postgres/queries/weekly/summary.sql` is created and no `Conflict` is returned

#### Scenario: Update overwrites the same files

- **WHEN** the user updates an existing context query at path `reports/top-customers` with new `sql`
- **THEN** `postgres/queries/reports/top-customers.sql` is overwritten and its `.meta.yaml` is updated

### Requirement: Rename a context query

The platform SHALL expose `context_rename_query({ connection_id: string, from_path: string, to_path: string })` that renames and/or moves both sibling files. `from_path` and `to_path` are relative POSIX paths under `queries/` without extension; `to_path` MAY reside in a different subfolder, in which case the query is moved (creating intermediate folders as needed) and its display `name` is updated from the final path segment's origin. The command MUST reject (`Conflict`) if a query already exists at `to_path`, reject (`NotFound`) if no query exists at `from_path`, and reject unsafe paths (absolute or containing `..`).

#### Scenario: Rename within the same folder

- **WHEN** the user renames context query `reports/top-customers` to `reports/best-customers`
- **THEN** the body and `.meta.yaml` are renamed accordingly and the meta `name` is updated
- **AND** the query remains under `queries/reports/`

#### Scenario: Rename moves across folders

- **WHEN** the user renames `top-customers` to `reports/top-customers`
- **THEN** the files move into `queries/reports/` (created if absent) and the query no longer exists at the root

#### Scenario: Rename onto an existing path is a conflict

- **WHEN** both `reports/top-customers` and `reports/best-customers` exist and the user renames the former to the latter
- **THEN** the command returns `Conflict` and no files are changed

### Requirement: Delete a context query

The platform SHALL expose `context_delete_query({ connection_id: string, path: string })` that removes the body file and its sibling `.meta.yaml` at the given relative path under `queries/`. Deleting a non-existent query SHALL return `NotFound`; unsafe paths SHALL be rejected.

#### Scenario: Delete removes both sibling files

- **WHEN** the user deletes context query at path `reports/top-customers`
- **THEN** `postgres/queries/reports/top-customers.sql` and its `.meta.yaml` are removed from disk

## ADDED Requirements

### Requirement: Query subfolders under queries/

The platform SHALL support nested subfolders under a connection's `<engine>/queries/` directory and expose commands to manage them:

- `context_create_query_folder({ connection_id: string, path: string })` SHALL create the folder `<root>/<engine>/queries/<path>` (including intermediate folders). `path` MUST be a relative POSIX path under `queries/`; absolute paths or `..` segments MUST be rejected; each segment MUST be normalized to a filesystem-safe form. Creating an already-existing folder is idempotent (no error). Returns the created relative path.
- `context_delete_query_folder({ connection_id: string, path: string })` SHALL remove the folder at `<root>/<engine>/queries/<path>` **only if it is empty** (no query files or subfolders); a non-empty folder SHALL return a structured error and delete nothing. Deleting a non-existent folder SHALL return `NotFound`.

After a successful create or delete, the platform SHALL cause a `context://changed` event whose `kinds` include `"query"` for the affected folder path (so subscribers refresh).

#### Scenario: Create a nested folder

- **WHEN** the user invokes `context_create_query_folder({ connection_id, path: "reports/2026" })` for a Postgres connection linked to `/repo/ctx`
- **THEN** `/repo/ctx/postgres/queries/reports/2026/` exists on disk

#### Scenario: Delete only removes an empty folder

- **WHEN** the user invokes `context_delete_query_folder` on a folder containing query files
- **THEN** the command returns an error and the folder and its contents are unchanged

#### Scenario: Unsafe folder path is rejected

- **WHEN** `context_create_query_folder` is invoked with an absolute path or a `..` segment
- **THEN** the command returns a validation error and creates nothing

### Requirement: Recursive listing reports queries and folders with paths

The platform SHALL read `<engine>/queries/` **recursively**. `context_list_queries({ connection_id })` SHALL return `{ queries, folders }` where each query item carries its relative `path` (POSIX, no extension), its parent `folder` (`""` at root), plus the existing `name`/`description`/`params`/`tags`; and `folders` is the list of all subfolder paths under `queries/`, including empty folders. `context_get_query({ connection_id, path })` SHALL resolve a query by its relative path and return its `QueryDoc` (including `path`, `folder`, and `body`), or null if absent.

#### Scenario: Nested queries are listed with paths

- **WHEN** `queries/top.sql` and `queries/reports/inner.sql` exist and an empty folder `queries/archive/` exists
- **THEN** `context_list_queries` returns query items with paths `top` (folder `""`) and `reports/inner` (folder `reports`)
- **AND** `folders` includes `reports` and `archive`

#### Scenario: Get resolves by relative path

- **WHEN** the user invokes `context_get_query({ connection_id, path: "reports/inner" })`
- **THEN** the returned `QueryDoc` has `path` `"reports/inner"` and the body of that file
