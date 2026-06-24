## MODIFIED Requirements

### Requirement: Saved Queries sidebar panel

The frontend SHALL render a `Saved Queries` panel in the sidebar between the `Connections` section and the `Plataforma` section. The panel surfaces **two sources** of queries in one tree: **local** queries (the legacy local-DB `saved_queries`/`saved_query_folders`) and **context** queries (prefab queries read from every linked context folder via the aggregate listing). The panel MUST:

- Always render whenever the local list and/or any context folder has queries; existing local-DB queries MUST remain visible (no regression to an empty/blank state when rows exist).
- Render a header row with the label `Saved Queries` and a `+` button. Clicking `+` opens a menu with `New query` and `New folder`. New-query creation MUST route to a context folder (see "Create a saved query"); `New folder` applies to the local-DB folder tree only.
- Render a search input below the header. Typing MUST filter the visible tree to nodes (folders or queries) whose `name` contains the input substring (case-insensitive). While the search input is non-empty, every ancestor of a matching node MUST be auto-expanded. Clearing the input MUST restore the previous expansion state.
- Render the tree via the existing `<SidebarTree />` component with virtualized rows. Each query row MUST carry a `source` indicator (`local` vs `context`); context queries MUST be grouped by their project (context folder) and engine so local and context entries are visually distinct and equivalent names never appear as accidental duplicates.
- Deduplicate context queries shared by multiple connections of the same canonical context root + engine, so a query stored once lists once.
- Persist the expansion state under settings key `savedQueries:expandedFolders` (a `string[]` of node ids), debounced 200ms on toggle. Search-driven auto-expansion MUST NOT pollute this persisted set.
- Refresh its context-query portion in response to `context://changed` events whose `kinds` include `"query"` for any linked folder path.

#### Scenario: Panel renders between Connections and Plataforma

- **WHEN** the sidebar is mounted
- **THEN** the DOM order is `ConnectionsSection`, then `SavedQueriesPanel`, then `PlatformSection`

#### Scenario: Both local and context queries are listed with source labels

- **WHEN** the local DB has a query `Legacy report` and a linked Postgres context folder has `postgres/queries/top-customers.sql`
- **THEN** the panel lists both `Legacy report` (source `local`) and `top-customers` (source `context`, under its project/engine group)

#### Scenario: Existing local queries remain visible (regression guard)

- **WHEN** the local DB contains saved queries and the app starts
- **THEN** the panel lists those queries and does not show an empty state

#### Scenario: Shared context query lists once

- **WHEN** two Postgres connections are linked to the same canonical context root containing `postgres/queries/top-customers.sql`
- **THEN** `top-customers` appears exactly once in the panel

#### Scenario: New context query appears live

- **WHEN** a query is authored into a linked context folder (via `context_save_query`)
- **THEN** a `context://changed` (`kinds` includes `"query"`) event causes the panel to show it without a manual reload

#### Scenario: Search filters and auto-expands ancestors

- **WHEN** the tree contains `reports/finance/revenue` and the user types `rev` in the search input
- **THEN** the `reports` folder is expanded, the `finance` folder is expanded, and the `revenue` query is visible
- **AND** other branches that don't match are hidden

#### Scenario: Clearing search restores previous expansion

- **WHEN** before searching, only `reports` was expanded (not `finance`)
- **AND** the user types and then clears the search input
- **THEN** `reports` is expanded, `finance` is collapsed (restored), and the persisted expansion set still excludes `finance`

### Requirement: Create a saved query

New saved queries SHALL be authored into a **context folder**, never inserted into the local `saved_queries` table. The frontend `New query` action and the SQL editor's `Save query` action MUST resolve a target context folder + engine and persist via `context_save_query` (see the `context-query-authoring` capability):

- **From the SQL editor**, the target is the active editor connection's linked context folder and engine; if that connection has no context folder, the user is prompted to link/create one before saving.
- **From the panel `+`**, when exactly one context folder is linked it is the default target; when multiple are linked, a picker selects the connection/folder; when none are linked, a call-to-action guides the user to link or create a context folder.

The legacy backend command `saved_queries_create` is retained but is no longer invoked by the create UI; it remains only for backward compatibility and tests.

#### Scenario: New query is written to the context folder, not the local DB

- **WHEN** the user saves a new query from a Postgres editor whose connection is linked to `/repo/ctx`
- **THEN** `context_save_query` writes `/repo/ctx/postgres/queries/<slug>.sql` (+ `.meta.yaml`)
- **AND** no new row is inserted into the local `saved_queries` table

#### Scenario: Saving without a linked context folder prompts to link one

- **WHEN** the user invokes `New query`/`Save query` and no context folder is linked for the relevant connection
- **THEN** the UI guides the user to link or create a context folder and does not create a local-DB query

#### Scenario: Multiple linked folders prompt for a target

- **WHEN** the user invokes the panel `+` `New query` and more than one context folder is linked
- **THEN** the UI presents a picker to choose the destination connection/folder before writing
