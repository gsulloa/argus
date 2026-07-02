## ADDED Requirements

### Requirement: Context query folder tree in the connection branch

The per-connection "Context Queries" branch SHALL render its queries as a **nested folder tree** reflecting the subfolder layout under `<engine>/queries/`. Queries at the root render directly; queries inside subfolders render under collapsible folder nodes; empty folders (reported by `context_list_queries`) render as empty collapsible nodes. Folder nodes SHALL sort before query rows at each level, each group sorted case-insensitively by name. The branch SHALL update via `context://changed` events whose `kinds` include `"query"`.

The branch SHALL let the user manage folders and place queries:

- A `New folder` affordance creates a subfolder via `context_create_query_folder`. When invoked with a folder node selected/targeted, the new folder is nested under it; otherwise it is created at the root of `queries/`.
- The `New query` affordance MAY target a folder: creating a query while a folder is targeted places it in that folder (passing `folder` to `context_save_query`); otherwise it is created at the root.
- Opening, renaming, and deleting a context query operate by the query's relative `path` (`context_get_query`/`context_rename_query`/`context_delete_query`), so identically named queries in different folders are unambiguous.
- An empty folder MAY be removed via `context_delete_query_folder`; removing a non-empty folder is not offered (or surfaces the backend error).

#### Scenario: Nested queries render under folder nodes

- **WHEN** a connection's folder has `queries/top.sql` and `queries/reports/inner.sql`
- **THEN** the branch shows `top` at the root and a `reports` folder node containing `inner`

#### Scenario: New folder creates a subfolder

- **WHEN** the user invokes `New folder` in the branch and names it `reports`
- **THEN** `context_create_query_folder` is called and a `reports` folder node appears (empty)

#### Scenario: New query into a folder

- **WHEN** the user invokes `New query` targeting the `reports` folder and names it `Top customers`
- **THEN** `context_save_query` is called with `folder: "reports"` and the query appears under `reports`

#### Scenario: Empty folder renders

- **WHEN** `context_list_queries` reports an empty folder `archive`
- **THEN** the branch shows an empty collapsible `archive` folder node

#### Scenario: Open resolves by path

- **WHEN** the user opens the query under `reports/inner`
- **THEN** the editor tab loads that query's body resolved by its relative path `reports/inner`
