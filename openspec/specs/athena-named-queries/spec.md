# athena-named-queries Specification

## Purpose
TBD - created by archiving change add-athena-named-queries. Update Purpose after archive.
## Requirements
### Requirement: List NamedQueries across all workgroups

The Athena module SHALL expose a Tauri command `athena_list_named_queries(connection_id)` that detects the AWS Athena NamedQueries across **all workgroups in the account** (not just the connection's configured workgroup) and returns them for the sidebar. The command MUST acquire the existing pooled client via `AthenaClientRegistry::acquire` and MUST NOT open a new connection. It MUST:

- Call `athena:ListWorkGroups`, following pagination, to enumerate every workgroup in the account.
- For each workgroup, call `athena:ListNamedQueries` with `WorkGroup = <workgroup name>`, following `NextToken` pagination, accumulating the NamedQuery IDs from every workgroup. A workgroup whose `ListNamedQueries` call fails (e.g. a `DISABLED` workgroup the credentials cannot enumerate) MUST be skipped without failing the whole listing.
- Resolve the aggregated IDs via `athena:BatchGetNamedQuery` in batches of at most 50 IDs per call. `BatchGetNamedQuery` resolves by ID account-wide and does NOT need to be repeated per workgroup; each returned `NamedQuery` already carries its own `work_group`.
- Return `Array<NamedQuerySummary>` where each entry is `{ named_query_id, name, description?, database, work_group }`. The `query_string` MUST NOT be included in this listing (it is fetched on demand — see "Get a NamedQuery").
- Sort the result by `work_group` then `name`, both case-insensitive.
- Complete within a bounded timeout consistent with the other Athena commands.

When `BatchGetNamedQuery` returns `unprocessed_named_query_ids`, the command MUST retry that sub-batch once; any IDs still unprocessed after the retry MUST be omitted from the result rather than failing the whole listing.

#### Scenario: NamedQueries listed from every workgroup

- **WHEN** the user invokes `athena.listNamedQueries(id)` and the account has two workgroups, one of which holds two NamedQueries and the other none
- **THEN** the response is an array of the two `{ named_query_id, name, description?, database, work_group }` entries
- **AND** each entry's `work_group` is the workgroup that actually owns it (independent of the connection's configured workgroup)
- **AND** no entry includes a `query_string`
- **AND** the entries are ordered by `work_group` then `name`, case-insensitively

#### Scenario: Connection workgroup does not constrain the result

- **WHEN** the connection is configured with workgroup `primary` (which has no NamedQueries) and another workgroup `analytics` holds NamedQueries
- **THEN** the response still includes the NamedQueries owned by `analytics`

#### Scenario: Aggregated pagination and batching

- **WHEN** the workgroups together hold more NamedQueries than a single `ListNamedQueries` page returns, and more than 50 in total
- **THEN** the command follows `ListWorkGroups` and per-workgroup `ListNamedQueries` pagination to collect every ID, and resolves them via `BatchGetNamedQuery` in batches of at most 50
- **AND** the returned array contains every NamedQuery across all workgroups

#### Scenario: A workgroup that cannot be enumerated is skipped

- **WHEN** one workgroup's `ListNamedQueries` call fails but others succeed
- **THEN** that workgroup is skipped and the command returns the NamedQueries from the workgroups that succeeded (no whole-listing failure)

#### Scenario: Account with no NamedQueries returns an empty list

- **WHEN** no workgroup in the account has any NamedQuery
- **THEN** the response is an empty array (not an error)

#### Scenario: Missing list permission surfaces an error

- **WHEN** the credentials lack `athena:ListWorkGroups` (or `athena:ListNamedQueries` for every workgroup)
- **THEN** the command returns an `AppError::Aws` carrying the access-denied code/message (retryable: false)
- **AND** the error does not affect the database/table listing of the same connection

### Requirement: Get a NamedQuery (with body)

The Athena module SHALL expose a Tauri command `athena_get_named_query(connection_id, named_query_id)` that returns the full NamedQuery including its body via `athena:GetNamedQuery`. The response MUST be `{ named_query_id, name, description?, database, work_group, query_string }`. `GetNamedQuery` resolves by ID regardless of which workgroup owns the query. The command MUST acquire the pooled client and complete within a bounded timeout.

#### Scenario: NamedQuery body fetched for opening in a tab

- **WHEN** the user invokes `athena.getNamedQuery(id, "nq-123")` for a query owned by any workgroup
- **THEN** the response includes `query_string` with the stored SQL text and the same metadata fields as the listing

#### Scenario: Unknown NamedQuery id returns an error

- **WHEN** the `named_query_id` does not exist
- **THEN** the command returns an `AppError` (not found / AWS error), and no tab is opened

### Requirement: Named Queries branch grouped by workgroup in the Athena sidebar

The Athena schema tree SHALL render a **"Named Queries"** branch under each Athena connection row, positioned above the databases, with its contents **grouped by workgroup**. The branch MUST behave as follows:

- It is lazy-loaded: its NamedQueries are fetched via `athena_list_named_queries` when the branch is first expanded (not on connect), with a visible loading state while in flight.
- Under the branch there is one sub-node per workgroup that owns at least one NamedQuery; workgroups with zero NamedQueries are omitted. Each workgroup sub-node shows the workgroup name and a count of its NamedQueries.
- Within a workgroup sub-node, each NamedQuery is a clickable leaf node displaying its `name`; when a `description` exists it is surfaced as a hint (e.g. tooltip / secondary text).
- Clicking a NamedQuery node MUST call `athena_get_named_query` for that node and then open a new Athena query tab via `openAthenaQueryTab(tabs, { connectionId, connectionName, sql: query_string })`, so the editor starts pre-filled with the stored SQL.
- When no workgroup in the account has any NamedQuery, the branch shows an empty state ("Sin named queries en la cuenta").
- When listing fails (e.g. missing `athena:ListWorkGroups` / `athena:ListNamedQueries`), the branch shows the `AppError` message **inline** within the branch and MUST NOT break the databases portion of the tree.
- The listing is cached in memory per connection (alongside the existing schema cache) and is invalidated on `athena:active-changed` (disconnect) and on a manual refresh of the connection.

#### Scenario: Branch groups queries by workgroup and opens one

- **WHEN** the user expands the "Named Queries" branch of a connected Athena connection whose account has NamedQueries in workgroup `analytics`
- **THEN** the branch shows an `analytics` sub-node (with a count) containing the NamedQueries, and omits workgroups that have none
- **WHEN** the user clicks a NamedQuery node
- **THEN** a new Athena query tab opens with that NamedQuery's `query_string` pre-filled in the editor

#### Scenario: Empty account shows empty state

- **WHEN** no workgroup in the account has any NamedQuery and the user expands the branch
- **THEN** the branch shows "Sin named queries en la cuenta" and no error

#### Scenario: Permission error shown inline without breaking the tree

- **WHEN** listing NamedQueries fails because the credentials lack `athena:ListWorkGroups`
- **THEN** the branch shows the error message inline
- **AND** the databases / tables / columns portion of the same connection's tree continues to load and work normally

#### Scenario: Cache invalidated on disconnect and refresh

- **WHEN** the connection disconnects (`athena:active-changed`) or the user manually refreshes the connection
- **THEN** the cached NamedQueries listing for that connection is invalidated and re-fetched on the next expand

### Requirement: Create a NamedQuery

The Athena module SHALL expose a Tauri command `athena_create_named_query(connection_id, name, query_string, database, work_group, description?)` that creates a new NamedQuery via `athena:CreateNamedQuery`. The command MUST acquire the existing pooled client via `AthenaClientRegistry::acquire`, MUST NOT open a new connection, and MUST reject the operation when the connection is read-only by returning `AppError::Validation` whose message contains "read-only" **before** issuing any AWS call. On success it MUST return the created query's identity including `named_query_id`, `work_group`, and `database` so the caller can link the originating tab to the new query. AWS errors (including access-denied for missing `athena:CreateNamedQuery`) MUST be mapped to `AppError` and propagated for inline display, with no a-priori permission probing.

#### Scenario: NamedQuery created from editor SQL

- **WHEN** the user invokes create with a `name`, the editor's `query_string`, a `database`, and a `work_group` on a writable connection
- **THEN** the command calls `athena:CreateNamedQuery` and returns the new `named_query_id` together with the `work_group` and `database` it was created in

#### Scenario: Create blocked on a read-only connection

- **WHEN** the connection is `read_only` and create is invoked
- **THEN** the command returns an `AppError::Validation` whose message contains "read-only"
- **AND** no `athena:CreateNamedQuery` call is made to AWS

#### Scenario: Missing create permission surfaces inline

- **WHEN** the credentials lack `athena:CreateNamedQuery`
- **THEN** the command returns the AWS access-denied error mapped to `AppError`
- **AND** the listing / get / branch behavior of the same connection is unaffected

### Requirement: Update a NamedQuery in place

The Athena module SHALL expose a Tauri command `athena_update_named_query(connection_id, named_query_id, name, query_string, description?)` that replaces a NamedQuery's `name`, `query_string`, and `description` via `athena:UpdateNamedQuery`. The command MUST acquire the pooled client and MUST reject the operation when the connection is read-only by returning `AppError::Validation` containing "read-only" before any AWS call. The command MUST NOT attempt to change the query's `database` or `work_group` (AWS `UpdateNamedQuery` has no such parameters); those remain fixed for the life of the query. AWS errors MUST be mapped to `AppError` and propagated for inline display.

#### Scenario: Body and metadata updated in place

- **WHEN** the user invokes update for an existing `named_query_id` with a new `name`, `query_string`, and `description` on a writable connection
- **THEN** the command calls `athena:UpdateNamedQuery` with that id, name, query_string, and description
- **AND** the query's `database` and `work_group` are unchanged

#### Scenario: Update blocked on a read-only connection

- **WHEN** the connection is `read_only` and update is invoked
- **THEN** the command returns an `AppError::Validation` whose message contains "read-only"
- **AND** no `athena:UpdateNamedQuery` call is made to AWS

#### Scenario: Update of an unknown id surfaces an error

- **WHEN** the `named_query_id` no longer exists (e.g. deleted in the console)
- **THEN** the command returns the AWS error mapped to `AppError` for inline display

### Requirement: Delete a NamedQuery

The Athena module SHALL expose a Tauri command `athena_delete_named_query(connection_id, named_query_id)` that deletes a NamedQuery via `athena:DeleteNamedQuery`. The command MUST acquire the pooled client and MUST reject the operation when the connection is read-only by returning `AppError::Validation` containing "read-only" before any AWS call. AWS errors (including access-denied for missing `athena:DeleteNamedQuery`) MUST be mapped to `AppError` for inline display.

#### Scenario: NamedQuery deleted

- **WHEN** the user confirms deletion of an existing `named_query_id` on a writable connection
- **THEN** the command calls `athena:DeleteNamedQuery` with that id and returns success

#### Scenario: Delete blocked on a read-only connection

- **WHEN** the connection is `read_only` and delete is invoked
- **THEN** the command returns an `AppError::Validation` whose message contains "read-only"
- **AND** no `athena:DeleteNamedQuery` call is made to AWS

### Requirement: Query tab remembers its NamedQuery origin

The Athena query tab payload SHALL carry an optional `origin` describing the NamedQuery a tab was opened from: `{ named_query_id, name, description?, database, work_group }`. The payload MUST remain backward compatible — a tab without `origin` is a valid "unlinked" tab. The tab's toolbar action MUST be conditional on `origin`:

- When `origin` is absent, the action reads "Save as Named Query" and performs a Create.
- When `origin` is present, the action reads "Update '<name>'" and performs an Update against `origin.named_query_id`.

After a successful Create, the originating tab MUST adopt the newly created query as its `origin` so that a subsequent save performs an Update rather than a second Create.

#### Scenario: Unlinked tab offers Save as Named Query

- **WHEN** a query tab has no `origin` (e.g. a fresh editor tab)
- **THEN** the toolbar shows "Save as Named Query" and saving performs a Create

#### Scenario: Linked tab offers Update

- **WHEN** a query tab was opened from a NamedQuery and carries its `origin`
- **THEN** the toolbar shows "Update '<name>'" and saving performs an Update against that `named_query_id`

#### Scenario: Tab re-links after a Create

- **WHEN** a Create succeeds from an unlinked tab
- **THEN** the tab adopts the new query's identity as its `origin`
- **AND** the toolbar action changes to "Update '<name>'" for the next save

### Requirement: Create / Update modal adapts to AWS field constraints

A single NamedQuery modal SHALL serve both Create and Update. In Create mode it MUST collect `name`, optional `description`, a `database` (pre-filled with the tab's active database, editable), and a `work_group` chosen from a picker defaulting to the connection's configured workgroup. In Update mode it MUST collect only `name` and optional `description`; the `database` and `work_group` MUST NOT be editable (AWS cannot change them on update) and MAY be shown read-only or omitted. The `query_string` saved MUST be the editor's current SQL.

#### Scenario: Create modal collects database and workgroup

- **WHEN** the user opens the modal from an unlinked tab
- **THEN** the modal shows name, description, an editable `database` pre-filled with the tab's active database, and a `work_group` picker defaulting to the connection's workgroup

#### Scenario: Update modal hides database and workgroup

- **WHEN** the user opens the modal from a tab linked to a NamedQuery
- **THEN** the modal shows only name and description for editing
- **AND** database and workgroup are not editable

### Requirement: Branch context menu with Edit and Delete

Each NamedQuery leaf in the "Named Queries" branch SHALL expose a context menu (⋯) with **Edit** and **Delete** actions, and clicking a leaf SHALL open a tab linked to that query's `origin`. **Edit** MUST open (or focus) the query in a linked tab — equivalent to clicking the leaf. **Delete** MUST present a confirmation modal showing the query's name and, on confirmation, call `athena_delete_named_query`. When the connection is read-only, the Delete action and the tab's Save/Update action MUST be hidden or disabled; the read-only Edit/open path MUST remain available. After a successful create, update, or delete, the per-connection NamedQueries listing cache MUST be invalidated and the branch re-fetched.

#### Scenario: Clicking a leaf opens a linked tab

- **WHEN** the user clicks a NamedQuery leaf in the branch
- **THEN** a query tab opens pre-filled with the query's SQL and carrying its `origin`

#### Scenario: Delete confirmation then removal

- **WHEN** the user selects Delete from a leaf's ⋯ menu on a writable connection
- **THEN** a confirmation modal shows the query's name
- **AND** on confirmation the query is deleted, the listing cache is invalidated, and the branch re-fetches

#### Scenario: Write actions hidden on a read-only connection

- **WHEN** the connection is `read_only`
- **THEN** the Delete menu action and the tab's Save/Update toolbar action are hidden or disabled
- **AND** clicking a leaf to open/read it still works

#### Scenario: Cache invalidated after a mutation

- **WHEN** a create, update, or delete succeeds
- **THEN** the cached NamedQueries listing for that connection is invalidated and re-fetched on the next branch render

