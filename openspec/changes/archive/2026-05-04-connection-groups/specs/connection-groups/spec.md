## ADDED Requirements

### Requirement: Group envelope

A connection group SHALL be stored as `{ id: UUIDv4, name: string, sort_order: real, created_at: integer, updated_at: integer }`. A group MUST NOT carry a `kind` or any source-type discriminator — groups are source-agnostic and can hold connections of any `kind`. `name` MAY collide between groups (uniqueness is by `id`).

#### Scenario: Group is source-agnostic

- **WHEN** a caller creates a group named "Production" and adds a connection with `kind: "postgres"` to it
- **AND** the same caller later adds a connection with `kind: "dynamo"` to the same group
- **THEN** both connections coexist in the group with no error

#### Scenario: Two groups may share a name

- **WHEN** a caller creates two groups with `name: "prod"`
- **THEN** both groups are persisted with distinct ids and the duplicate name is not rejected

### Requirement: List groups

The platform SHALL expose a Tauri command `connection_groups.list` that returns all stored groups ordered by `sort_order` ascending.

#### Scenario: Listing with no groups

- **WHEN** the user invokes `connection_groups.list` on a fresh database
- **THEN** the command returns an empty array

#### Scenario: Listing reflects manual order

- **WHEN** three groups exist with `sort_order` values `2.0`, `1.0`, `3.0`
- **AND** the user invokes `connection_groups.list`
- **THEN** the returned array is in order `[1.0, 2.0, 3.0]` by `sort_order`

### Requirement: Create group

The platform SHALL expose a Tauri command `connection_groups.create` that accepts `{ name }`, generates a fresh UUIDv4 id, assigns a `sort_order` greater than every existing group's `sort_order` so the new group appears last, sets `created_at` and `updated_at` to the current time, and returns the created group.

#### Scenario: First group created

- **WHEN** the user invokes `connection_groups.create` with `{ name: "Production" }` on a database with no groups
- **THEN** a row is persisted with the supplied name and a `sort_order` value greater than zero
- **AND** the returned group includes its `id`, `name`, `sort_order`, `created_at`, `updated_at`

#### Scenario: New group appears last by default

- **WHEN** two groups already exist with `sort_order` `1.0` and `2.0`
- **AND** the user invokes `connection_groups.create` with `{ name: "Local" }`
- **THEN** the new group is persisted with `sort_order` greater than `2.0`

#### Scenario: Validation rejects empty name

- **WHEN** the user invokes `connection_groups.create` with `name: ""` (empty or whitespace only)
- **THEN** the command returns an `AppError::Validation` and no row is created

### Requirement: Update group

The platform SHALL expose a Tauri command `connection_groups.update` that accepts `{ id, name?, sort_order? }`. Provided fields are updated; `id`, `created_at`, and contained connections are unchanged. `updated_at` MUST be set to the current time.

#### Scenario: Renaming a group

- **WHEN** the user invokes `connection_groups.update` with `{ id, name: "Staging" }`
- **THEN** the row's `name` is updated, `updated_at` is bumped, and `sort_order` is preserved

#### Scenario: Reordering a group

- **WHEN** the user invokes `connection_groups.update` with `{ id, sort_order: 1.5 }`
- **THEN** the row's `sort_order` is set to `1.5`, `updated_at` is bumped, and `name` is preserved

#### Scenario: Updating an unknown id

- **WHEN** the user invokes `connection_groups.update` for an id that does not exist
- **THEN** the command returns `AppError::NotFound`

### Requirement: Delete group

The platform SHALL expose a Tauri command `connection_groups.delete` that removes the SQLite row for the given id. Connections previously belonging to the group MUST have their `group_id` set to `NULL` by the database `ON DELETE SET NULL` constraint — connections MUST NOT be deleted by this command.

#### Scenario: Deleting an empty group

- **WHEN** a group with no member connections exists and the user invokes `connection_groups.delete` with its id
- **THEN** the group row is removed and no connections are affected

#### Scenario: Deleting a non-empty group preserves connections

- **WHEN** a group contains two connections and the user invokes `connection_groups.delete` with its id
- **THEN** the group row is removed
- **AND** both connections are preserved with `group_id` set to `NULL`

#### Scenario: Deleting an unknown id

- **WHEN** the user invokes `connection_groups.delete` for an id that does not exist
- **THEN** the command returns `AppError::NotFound`

### Requirement: Move a connection between groups

The platform SHALL expose a Tauri command `connections.move` that accepts `{ id, group_id, sort_order }` (where `group_id` MAY be `null` to move into the ungrouped sentinel section) and atomically updates both `group_id` and `sort_order` on the connection. `updated_at` MUST be set to the current time. The command MUST NOT touch any other field of the connection (`name`, `kind`, `params`, secret).

#### Scenario: Moving a connection into a group

- **WHEN** a connection with `group_id: null` and `sort_order: 1.0` exists
- **AND** the user invokes `connections.move` with `{ id, group_id: <some-group-id>, sort_order: 2.5 }`
- **THEN** the connection's `group_id` is set to the supplied group id, `sort_order` is `2.5`, and `updated_at` is bumped

#### Scenario: Moving a connection out of any group

- **WHEN** a connection has `group_id` set to a real group id
- **AND** the user invokes `connections.move` with `{ id, group_id: null, sort_order: 5.0 }`
- **THEN** the connection's `group_id` is set to `NULL` and the connection now sorts within the ungrouped section

#### Scenario: Move preserves params and secret

- **WHEN** a connection has stored params and a stored secret
- **AND** the user invokes `connections.move`
- **THEN** the params row is unchanged and the keychain entry under `connection:<id>` is unchanged

#### Scenario: Moving an unknown id

- **WHEN** the user invokes `connections.move` for an id that does not exist
- **THEN** the command returns `AppError::NotFound`

#### Scenario: Moving into an unknown group id

- **WHEN** the user invokes `connections.move` with a `group_id` that does not exist
- **THEN** the command returns `AppError::NotFound` and the connection is unchanged

### Requirement: Sidebar renders connections grouped by group

The connections section in the sidebar SHALL render connections grouped under their owning group, with one collapsible row per group followed by its member connections in `sort_order`. Connections whose `group_id` is `NULL` MUST render in a sentinel "Ungrouped" section that always sorts last and that MUST NOT be renameable, deletable, or reorderable.

#### Scenario: Group rows are collapsible

- **WHEN** the user clicks the chevron on a group row
- **THEN** the group's child connections are hidden and the group row shows a count of hidden members
- **AND** the collapsed state is persisted in `localStorage` keyed by the group's id

#### Scenario: Ungrouped section appears only when needed

- **WHEN** every connection in the database has a non-null `group_id`
- **THEN** the sidebar does not render an "Ungrouped" section header
- **AND** as soon as any connection's `group_id` becomes `NULL`, the section appears at the bottom

#### Scenario: Ungrouped section has no editing affordances

- **WHEN** the user opens the context menu on the "Ungrouped" section header
- **THEN** the menu offers no "Rename", "Delete", or "Reorder" action

### Requirement: Drag and drop reorders and re-parents connections

The connections section SHALL support drag-and-drop to (a) reorder a connection within its group, (b) move a connection between groups, and (c) reorder groups themselves. Each completed drop MUST result in exactly one IPC call: either `connections.move` for connection drops, or `connection_groups.update` for group reorderings. Drag-and-drop MUST be keyboard-operable and MUST announce its result to assistive technology.

#### Scenario: Reorder within the same group

- **WHEN** the user drags a connection from position 2 to position 4 within the same group
- **THEN** exactly one `connections.move` call is made with the same `group_id` and a new `sort_order` between the destination's neighbors

#### Scenario: Move between groups

- **WHEN** the user drags a connection from group A to a position inside group B
- **THEN** exactly one `connections.move` call is made with `group_id` set to B and a `sort_order` between the destination's neighbors in B

#### Scenario: Move into ungrouped section

- **WHEN** the user drags a connection from a group into the "Ungrouped" section
- **THEN** exactly one `connections.move` call is made with `group_id: null` and a `sort_order` placing it at the drop position

#### Scenario: Reorder a group

- **WHEN** the user drags a group from position 1 to position 3
- **THEN** exactly one `connection_groups.update` call is made with the new `sort_order`
- **AND** the order of the group's child connections is unchanged

#### Scenario: Keyboard drag-and-drop

- **WHEN** the user focuses a connection row, activates drag with the keyboard, and uses arrow keys to move it to a new position
- **THEN** the same single IPC call is made on commit
- **AND** a screen reader announcement describes the new group and position

### Requirement: Group context menu offers Rename, Sort alphabetically, Delete

Each group row SHALL expose a context menu (or `⋯` overflow button) with at minimum: Rename, Sort alphabetically, and Delete. The Sort alphabetically action MUST reassign `sort_order` on the group's member connections so they appear in case-insensitive alphabetical order by `name`. The Delete action MUST require a confirmation when the group has at least one member connection.

#### Scenario: Rename a group

- **WHEN** the user picks "Rename" on a group row and enters a new name
- **THEN** `connection_groups.update` is called with the new name and the sidebar reflects it

#### Scenario: Sort alphabetically reorders members

- **WHEN** a group has members in `sort_order` order `["zebra", "apple", "mango"]`
- **AND** the user picks "Sort alphabetically"
- **THEN** the members are reordered to `["apple", "mango", "zebra"]` via `connections.move` (or batched equivalent) and persist across reload

#### Scenario: Delete a non-empty group prompts for confirmation

- **WHEN** the user picks "Delete" on a group with members
- **THEN** the UI prompts to confirm and explains that members will move to "Ungrouped"
- **AND** on confirmation, `connection_groups.delete` is called and the members appear under "Ungrouped"

#### Scenario: Delete an empty group is silent

- **WHEN** the user picks "Delete" on a group with no members
- **THEN** the group is deleted without a confirmation prompt
