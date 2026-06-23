## MODIFIED Requirements

### Requirement: Connection envelope

A connection record SHALL be stored as a generic envelope: `{ id: UUIDv4, name: string, kind: string, params: object, group_id: UUIDv4 | null, sort_order: real, context_path: string | null, color: string | null, created_at, updated_at }`. The platform MUST NOT interpret the contents of `params` — that is the responsibility of the data-source module that owns the `kind`. `params` is always serialized to and from JSON for storage. `group_id` MAY be `null` (the connection is ungrouped) or reference a row in `connection_groups`. `sort_order` is a `REAL` value used for manual ordering inside the connection's group (or inside the ungrouped section when `group_id IS NULL`). `context_path` MAY be `null` (no context folder linked) or an absolute filesystem path stored verbatim as supplied by the user. `color` MAY be `null` (no color assigned) or one of the fixed palette keys defined by the connection-colors capability; it is stored as a plain text key, never a raw hex value.

#### Scenario: Envelope round-trips through storage

- **WHEN** a caller creates a connection with `name: "Local"`, `kind: "postgres"`, `params: { host: "localhost", port: 5432, database: "postgres", username: "me", sslmode: "disable" }`, no `group_id`, no `context_path`, no `color`, and a secret
- **AND** the caller subsequently lists connections
- **THEN** the listed connection has the same `name`, `kind`, and `params` shape as supplied
- **AND** `group_id` is `null`
- **AND** `context_path` is `null`
- **AND** `color` is `null`
- **AND** `sort_order` is a real number

#### Scenario: Envelope carries group membership

- **WHEN** a caller creates a connection with a `group_id` referencing an existing group
- **AND** the caller subsequently lists connections
- **THEN** the listed connection's `group_id` matches the supplied value

#### Scenario: Envelope carries context path

- **WHEN** a caller creates or updates a connection with `context_path: "/Users/me/code/billing/argus-context"`
- **AND** the caller subsequently lists connections
- **THEN** the listed connection's `context_path` equals the supplied path byte-for-byte

#### Scenario: Envelope carries color

- **WHEN** a caller creates or updates a connection with `color: "amber"`
- **AND** the caller subsequently lists connections
- **THEN** the listed connection's `color` equals `amber`

### Requirement: List connections

The platform SHALL expose a Tauri command `connections.list` that returns all stored connections ordered by their group's `sort_order` (with ungrouped connections last) and then by the connection's own `sort_order` ascending. The returned records MUST NOT contain any secret material and MUST include `group_id`, `sort_order`, and `color`.

#### Scenario: Listing with no connections

- **WHEN** the user invokes `connections.list` on a fresh database
- **THEN** the command returns an empty array

#### Scenario: Listing returns metadata only

- **WHEN** a connection is stored with a secret value
- **AND** the user invokes `connections.list`
- **THEN** the returned record contains `id`, `name`, `kind`, `params`, `group_id`, `sort_order`, `color`, `created_at`, `updated_at` and contains no field whose value is the secret

#### Scenario: Listing orders ungrouped connections last

- **WHEN** two groups exist (`A` with `sort_order` `1.0`, `B` with `sort_order` `2.0`) and three connections exist (one in `A`, one in `B`, one with `group_id: null`)
- **AND** the user invokes `connections.list`
- **THEN** the returned array contains the connection in `A` first, the connection in `B` next, and the ungrouped connection last

#### Scenario: Listing orders within a group by sort_order

- **WHEN** a group contains three connections with `sort_order` `2.0`, `1.0`, `3.0`
- **AND** the user invokes `connections.list`
- **THEN** within that group's segment of the result, the connections appear in `sort_order` order `[1.0, 2.0, 3.0]`

#### Scenario: Migrated database preserves alphabetical order

- **WHEN** an existing database with three connections named "alpha", "mango", "zebra" is upgraded to the schema introducing `sort_order`
- **AND** the user invokes `connections.list` for the first time after the upgrade
- **THEN** the returned order is `["alpha", "mango", "zebra"]` (alphabetical, matching pre-upgrade behaviour)

#### Scenario: Migrated database defaults color to null

- **WHEN** an existing database with connections created before the `color` column is upgraded to the schema introducing `color`
- **AND** the user invokes `connections.list`
- **THEN** every returned connection has `color: null`

### Requirement: Create connection

The platform SHALL expose a Tauri command `connections.create` that accepts `{ name, kind, params, group_id?, secret?, context_path?, color? }`, generates a fresh UUIDv4 id, assigns a `sort_order` greater than every existing connection's `sort_order` within the same group (or within the ungrouped section if `group_id` is omitted or `null`) so the new connection appears last in its section, stores the metadata in SQLite and the secret (if provided) in the OS keychain under service `argus`, account `connection:<id>`, and returns the created connection (without the secret). When `color` is provided it MUST be a valid palette key; an unknown key MUST be rejected with `AppError::Validation` and no row or keychain entry created. When `color` is omitted or `null` the new connection's color is `null`.

#### Scenario: Creating with a secret

- **WHEN** the user invokes `connections.create` with a secret string
- **THEN** the secret is written to the OS keychain under account `connection:<new id>` and the SQLite row contains no copy of the secret

#### Scenario: Creating without a secret

- **WHEN** the user invokes `connections.create` and omits `secret`
- **THEN** the connection is created and no keychain entry is written

#### Scenario: Creating without a group

- **WHEN** the user invokes `connections.create` and omits `group_id`
- **THEN** the connection is created with `group_id: null` and a `sort_order` greater than every existing ungrouped connection's `sort_order`

#### Scenario: Creating inside a group

- **WHEN** the user invokes `connections.create` with `group_id` set to an existing group's id
- **THEN** the connection is created with the supplied `group_id` and a `sort_order` greater than every existing member of that group

#### Scenario: Creating inside an unknown group id

- **WHEN** the user invokes `connections.create` with a `group_id` that does not exist
- **THEN** the command returns `AppError::NotFound` and no row or keychain entry is created

#### Scenario: Validation rejects empty name

- **WHEN** the user invokes `connections.create` with `name: ""` (empty or whitespace only)
- **THEN** the command returns an `AppError::Validation` and no row or keychain entry is created

#### Scenario: Creating with a color

- **WHEN** the user invokes `connections.create` with `color: "teal"`
- **THEN** the new connection's stored `color` is `teal`

#### Scenario: Creating with an invalid color is rejected

- **WHEN** the user invokes `connections.create` with `color: "neon"` (not a palette key)
- **THEN** the command returns `AppError::Validation` and no row or keychain entry is created

### Requirement: Update connection

The platform SHALL expose a Tauri command `connections.update` that accepts `{ id, name?, params?, secret?, context_path?, color? }`. Provided fields are updated; `kind`, `group_id`, and `sort_order` are immutable through this command. `updated_at` MUST be set to the current time. If `secret` is provided as `null` the keychain entry MUST be deleted and the cached entry MUST be evicted; if provided as a string the keychain entry MUST be replaced and the cache MUST be updated to hold the new value. If `secret` is omitted, neither the keychain nor the cache is touched for that id. `color` is interpreted as three-state: omitted means "leave unchanged"; an explicit palette key means "replace with that color"; an explicit `null` means "clear the color". A provided color key that is not in the palette MUST be rejected with `AppError::Validation` and MUST NOT mutate the row. Group membership and ordering are changed via the dedicated `connections.move` command (see `connection-groups` capability).

#### Scenario: Renaming

- **WHEN** the user invokes `connections.update` with `{ id, name: "New name" }`
- **THEN** the row's `name` is updated, `updated_at` is bumped, other fields are preserved, and the cached secret for that id is unchanged

#### Scenario: Replacing the secret

- **WHEN** the user invokes `connections.update` with `{ id, secret: "new value" }`
- **THEN** the keychain entry under `connection:<id>` now contains `"new value"` and the cached entry holds `"new value"`

#### Scenario: Clearing the secret

- **WHEN** the user invokes `connections.update` with `{ id, secret: null }`
- **THEN** the keychain entry under `connection:<id>` is deleted (or remains absent if it was never set) and the cached entry for that id is evicted

#### Scenario: Update does not change group_id

- **WHEN** a connection has `group_id` set to a group id and the user invokes `connections.update` with `{ id, name: "renamed" }`
- **THEN** the row's `group_id` and `sort_order` are unchanged

#### Scenario: Updating an unknown id

- **WHEN** the user invokes `connections.update` for an id that does not exist
- **THEN** the command returns `AppError::NotFound`

#### Scenario: Update sets color

- **WHEN** an existing connection has `color: null` and the user invokes `connections.update` with `{ id, color: "pink" }`
- **THEN** the row's `color` is now `pink` and `updated_at` is bumped

#### Scenario: Update clears color

- **WHEN** an existing connection has `color: "pink"` and the user invokes `connections.update` with `{ id, color: null }`
- **THEN** the row's `color` is now `null` and `updated_at` is bumped

#### Scenario: Update omits color

- **WHEN** an existing connection has `color: "pink"` and the user invokes `connections.update` with `{ id, name: "Renamed" }` and no `color` field
- **THEN** the row's `color` is unchanged at `pink`

#### Scenario: Update rejects an invalid color

- **WHEN** the user invokes `connections.update` with `{ id, color: "neon" }`
- **THEN** the command returns `AppError::Validation` and the row's `color` is unchanged
