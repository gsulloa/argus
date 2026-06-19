## ADDED Requirements

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
