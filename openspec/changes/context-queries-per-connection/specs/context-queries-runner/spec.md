## MODIFIED Requirements

### Requirement: Context queries sidebar branch

For each active connection (Postgres, MySQL, MSSQL, Dynamo), the sidebar SHALL render a "Context Queries" branch under the connection node, distinct from and rendered separately from the top-level "Saved Queries" panel. The branch is the **per-connection** home for context-folder queries and their creation. It SHALL:

- List the connection's parsed context queries by `name`, sorted alphabetically, when the connection is linked to a context folder containing matching `queries/` files. The branch SHALL update in response to `context://changed` events whose `kinds` include `"query"` for the connection's folder path.
- Render a `New query` affordance in the branch that authors a new context query into this connection's linked context folder via `context_save_query({ connection_id, name, sql: "" })`, then opens it in an editor tab. Name collisions surface the backend `Conflict` error as a toast.
- Render even when the linked folder currently has **no** queries (linked-but-empty), so the `New query` affordance is reachable; an empty hint MAY be shown.
- When the connection has **no** linked context folder, render a compact **setup call-to-action** in place of the query list that lets the user link or create a context folder for this connection — reusing the connection form's link/create primitives (`contextApi.listKnownFolders` → `contextApi.linkFolder`, `contextApi.createFolder` then `contextApi.linkFolder`, or `dialogOpen` → `contextApi.linkFolder`). On success the branch refreshes so its queries and `New query` action become available.

#### Scenario: Branch renders when queries exist

- **WHEN** a Postgres connection is linked to a folder with `postgres/queries/top-customers.sql` and `postgres/queries/stuck-orders.sql`
- **THEN** the sidebar shows a "Context Queries" branch under that connection containing `stuck-orders` and `top-customers` in that order

#### Scenario: New query authors into the connection's folder

- **WHEN** the user invokes `New query` in the branch of a connection linked to `/repo/ctx` and names it `Top customers`
- **THEN** `context_save_query` writes `/repo/ctx/<engine>/queries/top-customers.sql` (+ `.meta.yaml`)
- **AND** the new query opens in an editor tab and appears in the branch

#### Scenario: Branch shows New query when linked but empty

- **WHEN** a connection is linked to a context folder that has no `queries/` files for its engine
- **THEN** the branch still renders with a reachable `New query` affordance

#### Scenario: Setup CTA when no folder is linked

- **WHEN** a connection has no linked context folder
- **THEN** the branch renders a call-to-action to link or create a context folder for that connection
- **AND** completing the link refreshes the branch so `New query` and any existing queries become available

#### Scenario: Branch is distinct from Saved Queries

- **WHEN** the local-DB "Saved Queries" panel contains a query named `top-customers` and a linked folder also has `top-customers`
- **THEN** the local query shows in the Saved Queries panel and the context query shows in the connection's "Context Queries" branch, and the user can open both

## REMOVED Requirements

### Requirement: Context queries are runnable from the unified Saved Queries panel

**Reason**: The global Saved Queries panel no longer surfaces context queries — context queries are now shown and run exclusively from each connection's per-connection "Context Queries" branch. The unified/aggregated panel view is removed.

**Migration**: Open and run context queries from the connection's "Context Queries" branch in the sidebar. Per-engine parameter substitution and editor-tab behavior are unchanged (see "Open context query in editor tab" and "Run with named parameter substitution"). The backend `context_list_linked_queries` command is retained for compatibility but is no longer consumed by the UI.
