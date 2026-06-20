## ADDED Requirements

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
