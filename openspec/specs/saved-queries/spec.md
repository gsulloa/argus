# saved-queries Specification

## Purpose
TBD - created by syncing change add-saved-queries. Update Purpose after archive.
## Requirements
### Requirement: SQLite schema for saved queries and folders

The platform SHALL ship a SQLite migration `0003_saved_queries.sql` that creates two tables:

**`saved_query_folders`** with columns:
- `id` TEXT PRIMARY KEY (UUID v4)
- `parent_id` TEXT NULL, FOREIGN KEY (`saved_query_folders.id`) ON DELETE CASCADE
- `name` TEXT NOT NULL
- `sort_order` INTEGER NOT NULL DEFAULT 0
- `created_at` INTEGER NOT NULL (Unix ms)
- `updated_at` INTEGER NOT NULL (Unix ms)

**`saved_queries`** with columns:
- `id` TEXT PRIMARY KEY (UUID v4)
- `folder_id` TEXT NULL, FOREIGN KEY (`saved_query_folders.id`) ON DELETE CASCADE
- `name` TEXT NOT NULL
- `sql` TEXT NOT NULL
- `sort_order` INTEGER NOT NULL DEFAULT 0
- `last_connection_id` BLOB NULL (UUID v4)
- `created_at` INTEGER NOT NULL (Unix ms)
- `updated_at` INTEGER NOT NULL (Unix ms)

Indexes required:
- `idx_folders_parent` on `saved_query_folders(parent_id, sort_order)`
- `idx_queries_folder` on `saved_queries(folder_id, sort_order)`
- `idx_queries_name` on `saved_queries(name COLLATE NOCASE)`

Root-level entries (no parent folder) MUST have `parent_id IS NULL` for folders and `folder_id IS NULL` for queries.

#### Scenario: Migration applies cleanly on a fresh database

- **WHEN** the app starts against a database without `saved_query_folders` or `saved_queries`
- **THEN** the migration creates both tables and all three indexes
- **AND** subsequent app starts are idempotent (no errors)

#### Scenario: Cascade delete removes children of a deleted folder

- **WHEN** a folder `f1` contains subfolder `f2` and queries `q1`, `q2`, and `f1` is deleted via SQL
- **THEN** `f2`, `q1`, and `q2` are also removed from their tables

### Requirement: List folders and queries

The platform SHALL expose a Tauri command `saved_queries_list()` that returns the complete tree of folders and queries in a single payload:

```ts
{
  folders: Array<{
    id: string,
    parent_id: string | null,
    name: string,
    sort_order: number,
    created_at: number,
    updated_at: number,
  }>,
  queries: Array<{
    id: string,
    folder_id: string | null,
    name: string,
    sql: string,
    sort_order: number,
    last_connection_id: string | null,
    created_at: number,
    updated_at: number,
  }>,
}
```

The frontend is responsible for assembling the tree (group by parent). Both arrays MUST be sorted by `(parent_id|folder_id NULLS FIRST, sort_order ASC, name COLLATE NOCASE ASC)`.

The command MUST complete in O(N) where N is total rows and MUST NOT issue per-row queries.

#### Scenario: Empty database returns empty arrays

- **WHEN** no folders or queries have been created
- **THEN** the command returns `{ folders: [], queries: [] }`

#### Scenario: Mixed root and nested entries

- **WHEN** the database contains one root folder `reports`, one subfolder `reports/finance`, one query in `reports/finance` named `revenue`, and one root-level query `adhoc-test`
- **THEN** `folders` contains two entries (root `reports`, then `finance` with `parent_id = reports.id`)
- **AND** `queries` contains two entries (root `adhoc-test` with `folder_id = null`, then `revenue` with `folder_id = finance.id`)

### Requirement: Create a folder

The platform SHALL expose `saved_queries_folder_create({ parent_id?: string, name: string })` returning the created folder record. `name` MUST be trimmed and rejected with `AppError::Validation` if empty. `parent_id`, when provided, MUST reference an existing folder; otherwise return `AppError::Validation { message: "parent folder not found" }`. The new folder's `sort_order` MUST be `MAX(sort_order) + 1` among siblings (or 0 if no siblings). `created_at` and `updated_at` MUST be set to the current Unix ms.

Two folders may share the same name under the same parent — no unique constraint.

#### Scenario: Create root folder

- **WHEN** the user invokes `saved_queries_folder_create({ name: "reports" })`
- **THEN** a folder is inserted with `parent_id = null`, `name = "reports"`, `sort_order = 0`

#### Scenario: Create nested folder appends after siblings

- **WHEN** a parent folder already contains two child folders with `sort_order` 0 and 1
- **AND** the user invokes `saved_queries_folder_create({ parent_id, name: "third" })`
- **THEN** the new folder has `sort_order = 2`

#### Scenario: Empty name is rejected

- **WHEN** the user invokes `saved_queries_folder_create({ name: "   " })`
- **THEN** the command returns `AppError::Validation { message: "name is required" }`
- **AND** no row is inserted

### Requirement: Create a saved query

The platform SHALL expose `saved_queries_create({ folder_id?: string, name: string, sql: string, last_connection_id?: string })` returning the created record. `name` MUST be trimmed and rejected if empty. `sql` MAY be empty. `folder_id`, when provided, MUST reference an existing folder. `sort_order` MUST be `MAX(sort_order) + 1` among siblings in the target folder (or root).

#### Scenario: Create root-level query

- **WHEN** the user invokes `saved_queries_create({ name: "test", sql: "SELECT 1" })`
- **THEN** a query is inserted with `folder_id = null`, `name = "test"`, `sql = "SELECT 1"`, `last_connection_id = null`

#### Scenario: Create query inside a folder records last_connection_id

- **WHEN** the user invokes `saved_queries_create({ folder_id, name: "Revenue", sql: "SELECT …", last_connection_id: "uuid-of-prod" })`
- **THEN** the inserted row has `last_connection_id` set to the provided UUID
- **AND** the row's `folder_id` matches

### Requirement: Update a saved query

The platform SHALL expose `saved_queries_update({ id: string, name?: string, sql?: string, last_connection_id?: string | null })` to update one or more fields of an existing query. Omitted fields MUST be left unchanged (no overwrite with NULL unless `last_connection_id` is explicitly `null`). `name`, if provided, MUST be trimmed and rejected if empty. `updated_at` MUST be set to current Unix ms on any successful update. The command MUST return the full updated record.

#### Scenario: Update SQL only

- **WHEN** the user invokes `saved_queries_update({ id, sql: "SELECT 2" })`
- **THEN** the row's `sql` becomes `"SELECT 2"`, `name` is unchanged, `last_connection_id` is unchanged
- **AND** `updated_at` is greater than the previous value

#### Scenario: Clear last_connection_id explicitly

- **WHEN** the user invokes `saved_queries_update({ id, last_connection_id: null })`
- **THEN** the row's `last_connection_id` becomes NULL

#### Scenario: Update non-existent id returns NotFound

- **WHEN** the user invokes `saved_queries_update({ id: "missing", sql: "x" })`
- **THEN** the command returns `AppError::NotFound { resource: "saved_query", id: "missing" }`

### Requirement: Update folder name

The platform SHALL expose `saved_queries_folder_update({ id: string, name: string })` to rename a folder. `name` MUST be trimmed and non-empty. `updated_at` MUST be bumped. Returns the updated folder record.

#### Scenario: Rename a folder

- **WHEN** the user invokes `saved_queries_folder_update({ id, name: "renamed" })`
- **THEN** the folder's `name` becomes `"renamed"` and `updated_at` is bumped

### Requirement: Move a query to a different folder

The platform SHALL expose `saved_queries_move({ id: string, target_folder_id: string | null, target_sort_order?: number })`. When `target_folder_id` is `null`, the query moves to root. When `target_sort_order` is provided, the query takes that position among siblings and other siblings' `sort_order` MUST be renumbered to maintain a dense sequence. When omitted, the query MUST be appended (sort_order = max + 1). `updated_at` MUST be bumped.

#### Scenario: Move a query to root

- **WHEN** a query with `folder_id = f1` is moved with `target_folder_id: null`
- **THEN** the query's `folder_id` becomes NULL
- **AND** its `sort_order` is the new max among root-level queries

#### Scenario: Move with explicit sort position renumbers siblings

- **WHEN** a folder contains queries A, B, C with `sort_order` 0, 1, 2
- **AND** a new query D is moved into the folder with `target_sort_order: 1`
- **THEN** the final order is A (0), D (1), B (2), C (3)

### Requirement: Move a folder under a different parent

The platform SHALL expose `saved_queries_folder_move({ id: string, target_parent_id: string | null, target_sort_order?: number })`. The same sort semantics as `saved_queries_move` apply.

The command MUST reject moves that would create a cycle: if `target_parent_id` is a descendant of `id` (or equals `id`), return `AppError::Validation { message: "cannot move folder into its own descendant" }`. The cycle check MUST use a recursive CTE so deeply nested cases are detected.

#### Scenario: Move folder under another folder

- **WHEN** the user moves folder `f1` under `f2` and `f2` is not a descendant of `f1`
- **THEN** `f1.parent_id` becomes `f2.id`

#### Scenario: Cycle is rejected

- **WHEN** folder `parent` contains `child` which contains `grandchild`
- **AND** the user attempts to move `parent` under `grandchild`
- **THEN** the command returns `AppError::Validation`
- **AND** no rows are updated

#### Scenario: Self-move is rejected

- **WHEN** the user attempts to move folder `f` with `target_parent_id = f.id`
- **THEN** the command returns `AppError::Validation`

### Requirement: Delete a query

The platform SHALL expose `saved_queries_delete({ id: string })`. Hard delete. Returns `()` on success and `AppError::NotFound` if the id does not exist.

#### Scenario: Delete removes the row

- **WHEN** the user invokes `saved_queries_delete({ id })`
- **THEN** the row is removed from `saved_queries`
- **AND** subsequent `saved_queries_list()` does not include it

### Requirement: Delete a folder (cascade)

The platform SHALL expose `saved_queries_folder_delete({ id: string })`. Hard delete with cascade — subfolders and queries inside the folder MUST also be removed (handled by the `ON DELETE CASCADE` foreign key). Returns the count of deleted entities `{ folders_deleted: number, queries_deleted: number }`.

The command does NOT prompt for confirmation — the frontend is responsible for confirming with the user before invoking.

#### Scenario: Delete empty folder

- **WHEN** the user invokes `saved_queries_folder_delete({ id })` and the folder is empty
- **THEN** the result is `{ folders_deleted: 1, queries_deleted: 0 }`

#### Scenario: Delete folder with nested content

- **WHEN** a folder contains one subfolder and three queries (two in the parent, one in the subfolder)
- **AND** the user invokes `saved_queries_folder_delete` on the parent
- **THEN** the result is `{ folders_deleted: 2, queries_deleted: 3 }`
- **AND** none of those rows remain in either table

### Requirement: Duplicate a saved query

The platform SHALL expose `saved_queries_duplicate({ id: string })` that copies an existing query into the same folder with `name` set to `"<original name> (copy)"` and returns the new record. `last_connection_id` MUST be copied as-is. `sort_order` MUST be `MAX(sort_order) + 1` among siblings. New `id`, `created_at`, and `updated_at` MUST be generated.

If a sibling already has the same `(name) (copy)` name, the duplicate MUST be named `(name) (copy 2)`, `(copy 3)`, etc. — incrementing the smallest available integer suffix.

#### Scenario: First duplicate appends (copy)

- **WHEN** the user duplicates a query named `Revenue` in a folder
- **THEN** a new query is created in the same folder named `Revenue (copy)`

#### Scenario: Second duplicate increments the suffix

- **WHEN** the user duplicates `Revenue` and a sibling `Revenue (copy)` already exists
- **THEN** the new query is named `Revenue (copy 2)`

### Requirement: Saved Queries sidebar panel

The frontend SHALL render a `Saved Queries` panel in the sidebar between the `Connections` section and the `Plataforma` section. The panel MUST:

- Render a header row with the label `Saved Queries` and a `+` button. Clicking `+` opens a menu with two items: `New query` and `New folder`. The menu MAY also be opened via right-click on the panel header.
- Render a search input below the header. Typing MUST filter the visible tree to nodes (folders or queries) whose `name` contains the input substring (case-insensitive). While the search input is non-empty, every ancestor of a matching node MUST be auto-expanded. Clearing the input MUST restore the previous expansion state.
- Render the tree via the existing `<SidebarTree />` component (`src/platform/shell/SidebarTree.tsx`) with virtualized rows. Each row shows a folder icon or query icon plus the name; folders show an expand chevron.
- Persist the expansion state under settings key `savedQueries:expandedFolders` (a `string[]` of folder ids), debounced 200ms on toggle. Search-driven auto-expansion MUST NOT pollute this persisted set.

#### Scenario: Panel renders between Connections and Plataforma

- **WHEN** the sidebar is mounted
- **THEN** the DOM order is `ConnectionsSection`, then `SavedQueriesPanel`, then `PlatformSection`

#### Scenario: Search filters and auto-expands ancestors

- **WHEN** the tree contains `reports/finance/revenue` and the user types `rev` in the search input
- **THEN** the `reports` folder is expanded, the `finance` folder is expanded, and the `revenue` query is visible
- **AND** other branches that don't match are hidden

#### Scenario: Clearing search restores previous expansion

- **WHEN** before searching, only `reports` was expanded (not `finance`)
- **AND** the user types and then clears the search input
- **THEN** `reports` is expanded, `finance` is collapsed (restored), and the persisted expansion set still excludes `finance`

### Requirement: Context menu and keyboard interactions on tree nodes

The panel MUST provide a right-click context menu and keyboard shortcuts on tree nodes:

**On a query node:**
- `Open` (default action; also bound to `Enter` and double-click): invokes the open flow per the `postgres-sql-editor` capability.
- `Open in new tab`: forces a new tab even if one already exists for this query.
- `Rename` (also `F2`): activates inline rename.
- `Duplicate`: invokes `saved_queries_duplicate`.
- `Move to folder…`: opens a folder-picker modal.
- `Delete` (also `Backspace`/`Delete` key): opens a confirmation dialog; on confirm invokes `saved_queries_delete`.

**On a folder node:**
- `New query` and `New folder`: create children of this folder.
- `Rename` (also `F2`).
- `Delete`: if the folder is non-empty, confirmation dialog reads `Delete folder "<name>" and all <n> items inside?`. If empty, confirmation reads `Delete folder "<name>"?`. On confirm invokes `saved_queries_folder_delete`.

**On the empty area / root:**
- `New query`, `New folder`, `Collapse all`.

Inline rename: the row's label becomes a `<input>` pre-filled with the current name and selected. `Enter` commits via `saved_queries_update` or `saved_queries_folder_update`; `Escape` cancels; empty trimmed names cancel silently.

#### Scenario: F2 enters rename mode

- **WHEN** the user focuses a query node with the keyboard and presses F2
- **THEN** the label is replaced with an editable input pre-filled with the name and selected
- **AND** the input has focus

#### Scenario: Delete query confirms before invoking

- **WHEN** the user invokes `Delete` on a query node
- **THEN** a confirmation dialog appears reading `Delete query "<name>"?`
- **AND** invoking `saved_queries_delete` happens only on confirmation

#### Scenario: Delete non-empty folder shows count

- **WHEN** the user invokes `Delete` on a folder containing 1 subfolder + 3 queries
- **THEN** the confirmation dialog reads `Delete folder "<name>" and all 4 items inside?`

### Requirement: Drag-and-drop reorganization

The tree MUST support drag-and-drop via the same `dnd-kit` integration as the existing `<SidebarTree />`:

- Drag a query onto a folder row → move into that folder (append at end). Visual: folder row highlights as drop target.
- Drag a folder onto another folder row → move as child of that folder (validate no-cycle; if cycle, abort visually with shake animation).
- Drag a query or folder between two rows in the same parent → reorder (insert at that slot). Visual: a horizontal line indicates the insertion position.
- Drag onto the root area at the top/bottom of the panel → move to root.
- During drag, the source row MUST render at 50% opacity. The dragged element MUST follow the cursor with a ghost preview.

On drop, the frontend MUST invoke `saved_queries_move` (or `saved_queries_folder_move`) and refresh the tree from the server response. On validation error (e.g. cycle), surface a toast `Cannot move folder into its own descendant.` and abort.

#### Scenario: Drag query into folder

- **WHEN** the user drags a query node and drops it on a folder node
- **THEN** `saved_queries_move` is invoked with the query id and the folder's id
- **AND** on success the query appears as the last child of that folder

#### Scenario: Drag folder into descendant is rejected visually

- **WHEN** the user drags folder `parent` and drops it on its descendant `grandchild`
- **THEN** the drop is rejected (no command issued or backend returns Validation)
- **AND** a toast `Cannot move folder into its own descendant.` appears
- **AND** the tree state is unchanged

#### Scenario: Drag to reorder within same parent

- **WHEN** a folder contains queries A, B, C and the user drags C between A and B
- **THEN** `saved_queries_move` is invoked with `target_sort_order: 1`
- **AND** the resulting order is A, C, B
