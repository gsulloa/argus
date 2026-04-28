# connection-registry Specification

## Purpose
TBD - created by archiving change bootstrap-tauri-shell. Update Purpose after archive.
## Requirements
### Requirement: Local storage initialization

On application startup the platform SHALL ensure a SQLite database exists at `<app_data_dir>/argus.db` and that all pending schema migrations have been applied. If the directory does not exist it MUST be created. If migrations fail the application MUST NOT proceed to render the main window and MUST surface a clear error.

#### Scenario: First launch creates the database

- **WHEN** the user launches Argus for the first time and no database file exists
- **THEN** the platform creates `<app_data_dir>/argus.db` with the initial schema (tables `_migrations`, `connections`, `settings`) and a recorded migration version

#### Scenario: Subsequent launches reuse the database

- **WHEN** the user launches Argus with an existing `argus.db` already at the latest migration version
- **THEN** the platform opens the existing database without modification and proceeds to render the window

#### Scenario: Migration failure blocks startup

- **WHEN** a pending migration fails during startup (for example, the disk is full or the file is corrupt)
- **THEN** the application surfaces an error to the user (dialog or fallback window) and does not render the main shell

### Requirement: Connection envelope

A connection record SHALL be stored as a generic envelope: `{ id: UUIDv4, name: string, kind: string, params: object, created_at, updated_at }`. The platform MUST NOT interpret the contents of `params` — that is the responsibility of the data-source module that owns the `kind`. In this change `params` is always serialized to and from JSON for storage.

#### Scenario: Envelope round-trips through storage

- **WHEN** a caller creates a connection with `name: "Local"`, `kind: "postgres"`, `params: { host: "localhost", port: 5432, database: "postgres", username: "me", sslmode: "disable" }` and a secret
- **AND** the caller subsequently lists connections
- **THEN** the listed connection has the same `name`, `kind`, and `params` shape as supplied

### Requirement: List connections

The platform SHALL expose a Tauri command `connections.list` that returns all stored connections ordered by `name` ascending. The returned records MUST NOT contain any secret material.

#### Scenario: Listing with no connections

- **WHEN** the user invokes `connections.list` on a fresh database
- **THEN** the command returns an empty array

#### Scenario: Listing returns metadata only

- **WHEN** a connection is stored with a secret value
- **AND** the user invokes `connections.list`
- **THEN** the returned record contains `id`, `name`, `kind`, `params`, `created_at`, `updated_at` and contains no field whose value is the secret

### Requirement: Create connection

The platform SHALL expose a Tauri command `connections.create` that accepts `{ name, kind, params, secret? }`, generates a fresh UUIDv4 id, stores the metadata in SQLite and the secret (if provided) in the OS keychain under service `argus`, account `connection:<id>`, and returns the created connection (without the secret).

#### Scenario: Creating with a secret

- **WHEN** the user invokes `connections.create` with a secret string
- **THEN** the secret is written to the OS keychain under account `connection:<new id>` and the SQLite row contains no copy of the secret

#### Scenario: Creating without a secret

- **WHEN** the user invokes `connections.create` and omits `secret`
- **THEN** the connection is created and no keychain entry is written

#### Scenario: Validation rejects empty name

- **WHEN** the user invokes `connections.create` with `name: ""` (empty or whitespace only)
- **THEN** the command returns an `AppError::Validation` and no row or keychain entry is created

### Requirement: Update connection

The platform SHALL expose a Tauri command `connections.update` that accepts `{ id, name?, params?, secret? }`. Provided fields are updated; `kind` is immutable. `updated_at` MUST be set to the current time. If `secret` is provided as `null` the keychain entry MUST be deleted; if provided as a string the keychain entry MUST be replaced.

#### Scenario: Renaming

- **WHEN** the user invokes `connections.update` with `{ id, name: "New name" }`
- **THEN** the row's `name` is updated, `updated_at` is bumped, and other fields are preserved

#### Scenario: Replacing the secret

- **WHEN** the user invokes `connections.update` with `{ id, secret: "new value" }`
- **THEN** the keychain entry under `connection:<id>` now contains `"new value"`

#### Scenario: Clearing the secret

- **WHEN** the user invokes `connections.update` with `{ id, secret: null }`
- **THEN** the keychain entry under `connection:<id>` is deleted (or remains absent if it was never set)

#### Scenario: Updating an unknown id

- **WHEN** the user invokes `connections.update` for an id that does not exist
- **THEN** the command returns `AppError::NotFound`

### Requirement: Delete connection

The platform SHALL expose a Tauri command `connections.delete` that removes the SQLite row for the given id and deletes the corresponding keychain entry if one exists. Deleting an id that does not exist MUST return `AppError::NotFound`.

#### Scenario: Deleting an existing connection

- **WHEN** a connection with secret exists and the user invokes `connections.delete` with its id
- **THEN** both the SQLite row and the keychain entry under `connection:<id>` are removed

#### Scenario: Deleting an unknown id

- **WHEN** the user invokes `connections.delete` for an id that does not exist
- **THEN** the command returns `AppError::NotFound`

### Requirement: Get secret

The platform SHALL expose a Tauri command `connections.getSecret` that returns the secret string for a given connection id from the OS keychain, or `null` if no secret is stored. This command is the only path through which secrets cross the IPC boundary, and it MUST be invoked only by data-source modules at the moment they need to open a network connection.

#### Scenario: Retrieving an existing secret

- **WHEN** a connection has a stored secret and a module invokes `connections.getSecret` with its id
- **THEN** the command returns the secret string

#### Scenario: No secret stored

- **WHEN** a connection exists but has no secret stored
- **AND** a module invokes `connections.getSecret` with its id
- **THEN** the command returns `null`

#### Scenario: Unknown id

- **WHEN** a module invokes `connections.getSecret` for an id that does not exist in the connections table
- **THEN** the command returns `AppError::NotFound`

