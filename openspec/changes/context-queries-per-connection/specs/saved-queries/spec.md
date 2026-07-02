## MODIFIED Requirements

### Requirement: Create a saved query

New **context** queries SHALL be authored into a connection's linked **context folder** via `context_save_query` (see the `context-query-authoring` capability). Context-query creation is a **per-connection** action, initiated from exactly two places:

- **From the SQL editor**, the target is the active editor connection's linked context folder and engine; if that connection has no context folder, the user is prompted to link/create one before saving.
- **From the connection's `Context Queries` sidebar branch**, the target is that connection's linked context folder and engine (see the `context-queries-runner` capability).

The global Saved Queries panel SHALL NOT author queries: it has no `New query` action and never writes to a context folder or to the local `saved_queries` table.

The legacy backend command `saved_queries_create` is retained for backward compatibility and tests but is no longer invoked by any create UI. Existing local-DB saved queries remain listed and manageable in the panel; no new local-DB queries are created.

#### Scenario: New query is written to the context folder, not the local DB

- **WHEN** the user saves a new query from a Postgres editor whose connection is linked to `/repo/ctx`
- **THEN** `context_save_query` writes `/repo/ctx/postgres/queries/<slug>.sql` (+ `.meta.yaml`)
- **AND** no new row is inserted into the local `saved_queries` table

#### Scenario: New query created from the connection branch targets that connection's folder

- **WHEN** the user invokes `New query` in a connection's `Context Queries` branch and that connection is linked to `/repo/ctx`
- **THEN** `context_save_query` writes into `/repo/ctx/<engine>/queries/` for that connection

#### Scenario: Global panel offers no query creation

- **WHEN** the user opens the global Saved Queries panel `+` menu
- **THEN** it offers `New folder` (local-DB organization) and no `New query` action

### Requirement: Saved Queries sidebar panel

The frontend SHALL render a `Saved Queries` panel in the sidebar between the `Connections` section and the `Plataforma` section. The panel surfaces **only local** queries — the local-DB `saved_queries`/`saved_query_folders`. Context-folder queries are NOT surfaced here; they appear under each connection's own `Context Queries` branch (see the `context-queries-runner` capability). The panel MUST:

- Always render whenever the local list has queries; existing local-DB queries MUST remain visible (no regression to an empty/blank state when rows exist).
- Render a header row with the label `Saved Queries` and a `+` button. Clicking `+` opens a menu with a single `New folder` action that applies to the local-DB folder tree. The panel MUST NOT offer a `New query` action.
- Render a search input below the header. Typing MUST filter the visible tree to nodes (folders or queries) whose `name` contains the input substring (case-insensitive). While the search input is non-empty, every ancestor of a matching node MUST be auto-expanded. Clearing the input MUST restore the previous expansion state.
- Render the tree via the existing `<SidebarTree />` component with virtualized rows.
- Persist the expansion state under settings key `savedQueries:expandedFolders` (a `string[]` of node ids), debounced 200ms on toggle. Search-driven auto-expansion MUST NOT pollute this persisted set.

#### Scenario: Panel renders between Connections and Plataforma

- **WHEN** the sidebar is mounted
- **THEN** the DOM order is `ConnectionsSection`, then `SavedQueriesPanel`, then `PlatformSection`

#### Scenario: Panel lists only local queries

- **WHEN** the local DB has a query `Legacy report` and a linked Postgres context folder has `postgres/queries/top-customers.sql`
- **THEN** the panel lists `Legacy report` and does NOT list `top-customers`
- **AND** `top-customers` appears under its connection's `Context Queries` branch instead

#### Scenario: Existing local queries remain visible (regression guard)

- **WHEN** the local DB contains saved queries and the app starts
- **THEN** the panel lists those queries and does not show an empty state

#### Scenario: Panel + menu has no New query

- **WHEN** the user opens the panel `+` menu
- **THEN** it shows only `New folder`
