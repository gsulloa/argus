## MODIFIED Requirements

### Requirement: Connection envelope

A connection record SHALL be stored as a generic envelope: `{ id: UUIDv4, name: string, kind: string, params: object, group_id: UUIDv4 | null, sort_order: real, context_path: string | null, created_at, updated_at }`. The platform MUST NOT interpret the contents of `params` — that is the responsibility of the data-source module that owns the `kind`. `params` is always serialized to and from JSON for storage. `group_id` MAY be `null` (the connection is ungrouped) or reference a row in `connection_groups`. `sort_order` is a `REAL` value used for manual ordering inside the connection's group (or inside the ungrouped section when `group_id IS NULL`). `context_path` MAY be `null` (no context folder linked) or an absolute filesystem path stored verbatim as supplied by the user.

#### Scenario: Envelope round-trips through storage

- **WHEN** a caller creates a connection with `name: "Local"`, `kind: "postgres"`, `params: { host: "localhost", port: 5432, database: "postgres", username: "me", sslmode: "disable" }`, no `group_id`, no `context_path`, and a secret
- **AND** the caller subsequently lists connections
- **THEN** the listed connection has the same `name`, `kind`, and `params` shape as supplied
- **AND** `group_id` is `null`
- **AND** `context_path` is `null`
- **AND** `sort_order` is a real number

#### Scenario: Envelope carries group membership

- **WHEN** a caller creates a connection with a `group_id` referencing an existing group
- **AND** the caller subsequently lists connections
- **THEN** the listed connection's `group_id` matches the supplied value

#### Scenario: Envelope carries context path

- **WHEN** a caller creates or updates a connection with `context_path: "/Users/me/code/billing/argus-context"`
- **AND** the caller subsequently lists connections
- **THEN** the listed connection's `context_path` equals the supplied path byte-for-byte

## ADDED Requirements

### Requirement: Set context path on create and update

The `connections.create` command SHALL accept an optional `context_path: string | null` field in its input and persist it on the new row. The `connections.update` command SHALL accept an optional `context_path` field interpreted as three-state: omitted means "leave unchanged"; an explicit string means "replace with this path"; an explicit `null` means "clear the context path". Setting `context_path` SHALL NOT validate the folder's existence or contents — validation is the responsibility of the context-folders capability when the connection is linked or loaded.

#### Scenario: Create with context path

- **WHEN** the user invokes `connections.create` with `context_path: "/Users/me/billing/ctx"` alongside the other required fields
- **THEN** the new row's `context_path` equals `/Users/me/billing/ctx`

#### Scenario: Create without context path

- **WHEN** the user invokes `connections.create` and omits `context_path`
- **THEN** the new row's `context_path` is `null`

#### Scenario: Update sets context path

- **WHEN** an existing connection has `context_path: null` and the user invokes `connections.update` with `context_path: "/Users/me/billing/ctx"`
- **THEN** the row's `context_path` is now `/Users/me/billing/ctx` and `updated_at` is bumped

#### Scenario: Update clears context path

- **WHEN** an existing connection has `context_path: "/Users/me/billing/ctx"` and the user invokes `connections.update` with `context_path: null`
- **THEN** the row's `context_path` is now `null` and `updated_at` is bumped

#### Scenario: Update omits context path

- **WHEN** an existing connection has `context_path: "/Users/me/billing/ctx"` and the user invokes `connections.update` with `name: "Renamed"` and no `context_path` field
- **THEN** the row's `context_path` is unchanged at `/Users/me/billing/ctx`

#### Scenario: Delete does not touch folder on disk

- **WHEN** a connection with `context_path: "/Users/me/billing/ctx"` is deleted via `connections.delete`
- **THEN** the row is removed and the folder at `/Users/me/billing/ctx` on disk is not modified
