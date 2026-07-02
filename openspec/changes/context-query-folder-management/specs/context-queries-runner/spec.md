## ADDED Requirements

### Requirement: Context query management actions in the branch

The per-connection Context Queries branch SHALL provide a context menu (right-click, and/or an affordance) on each **query row** offering:

- **Open** — activate the query (existing behavior).
- **Move to folder…** — opens a picker listing every destination folder for this connection's `queries/` tree (the root plus every folder, excluding the query's current folder). Selecting a destination invokes `context_rename_query({ connection_id, from_path, to_path })` where `to_path` keeps the query's slug under the chosen folder (root → bare slug). On success the branch refreshes and the query appears under the new folder.
- **Rename** — prompts for a new display name and invokes `context_rename_query` with a `to_path` that keeps the query in its current folder but changes the slug/name.
- **Delete** — after a confirmation, invokes `context_delete_query({ connection_id, path })` and refreshes.

Each **folder node** SHALL offer **Delete folder**, enabled only when the folder is empty, invoking `context_delete_query_folder({ connection_id, path })`; attempting to delete a non-empty folder surfaces the backend error as a toast rather than deleting contents.

All actions operate by the query's relative `path`, so identically named queries in different folders are unambiguous.

#### Scenario: Move a query to another folder

- **WHEN** the user chooses "Move to folder…" on query `top-customers` (currently at root) and selects the `reports` folder
- **THEN** `context_rename_query` is invoked with `from_path: "top-customers"` and `to_path: "reports/top-customers"`
- **AND** after refresh the query appears under `reports` and no longer at the root

#### Scenario: Move picker excludes the current folder

- **WHEN** the user opens "Move to folder…" for a query already inside `reports`
- **THEN** the destination list does not offer `reports` as a target

#### Scenario: Rename a query in place

- **WHEN** the user renames query at `reports/top-customers` to `Best customers`
- **THEN** `context_rename_query` is invoked with `to_path` `reports/best-customers` and the display name updates

#### Scenario: Delete a query with confirmation

- **WHEN** the user chooses "Delete" on a query and confirms
- **THEN** `context_delete_query` is invoked with the query's `path` and the row disappears after refresh

#### Scenario: Delete empty folder only

- **WHEN** the user chooses "Delete folder" on an empty folder
- **THEN** `context_delete_query_folder` is invoked and the folder disappears
- **AND** attempting it on a non-empty folder surfaces an error and deletes nothing
