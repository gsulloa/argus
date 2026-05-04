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

The platform SHALL expose a Tauri command `connections.update` that accepts `{ id, name?, params?, secret? }`. Provided fields are updated; `kind` is immutable. `updated_at` MUST be set to the current time. If `secret` is provided as `null` the keychain entry MUST be deleted and the cached entry MUST be evicted; if provided as a string the keychain entry MUST be replaced and the cache MUST be updated to hold the new value. If `secret` is omitted, neither the keychain nor the cache is touched for that id.

#### Scenario: Renaming

- **WHEN** the user invokes `connections.update` with `{ id, name: "New name" }`
- **THEN** the row's `name` is updated, `updated_at` is bumped, other fields are preserved, and the cached secret for that id is unchanged

#### Scenario: Replacing the secret

- **WHEN** the user invokes `connections.update` with `{ id, secret: "new value" }`
- **THEN** the keychain entry under `connection:<id>` now contains `"new value"` and the cached entry holds `"new value"`

#### Scenario: Clearing the secret

- **WHEN** the user invokes `connections.update` with `{ id, secret: null }`
- **THEN** the keychain entry under `connection:<id>` is deleted (or remains absent if it was never set) and the cached entry for that id is evicted

#### Scenario: Updating an unknown id

- **WHEN** the user invokes `connections.update` for an id that does not exist
- **THEN** the command returns `AppError::NotFound`

### Requirement: Delete connection

The platform SHALL expose a Tauri command `connections.delete` that removes the SQLite row for the given id, deletes the corresponding keychain entry if one exists, and evicts the cached secret entry if one exists. Deleting an id that does not exist MUST return `AppError::NotFound`.

#### Scenario: Deleting an existing connection

- **WHEN** a connection with secret exists and the user invokes `connections.delete` with its id
- **THEN** the SQLite row is removed, the keychain entry under `connection:<id>` is removed, and the cached secret entry for that id is evicted

#### Scenario: Deleting an unknown id

- **WHEN** the user invokes `connections.delete` for an id that does not exist
- **THEN** the command returns `AppError::NotFound`

### Requirement: Get secret

The platform SHALL expose a Tauri command `connections.getSecret` that returns the secret string for a given connection id, or `null` if no secret is stored. This command is the only path through which secrets cross the IPC boundary, and it MUST be invoked only by data-source modules at the moment they need to open a network connection. The command reads from the in-process secret cache when populated and falls through to the OS keychain on a cache miss; on a miss, the keychain result MUST be inserted into the cache before the command returns.

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

#### Scenario: Repeated retrieval is served from the cache

- **WHEN** a module invokes `connections.getSecret` with an id whose secret is already cached
- **THEN** the command returns the cached value without invoking the OS keychain

### Requirement: Secret cache

The platform SHALL maintain a process-lifetime in-memory cache of connection secrets, populated lazily on first read and kept consistent with the OS keychain through write-through and evict semantics. Cache hits MUST NOT invoke the OS keychain. The cache MUST be cleared when the application process exits — it MUST NOT persist to disk.

#### Scenario: Warm read does not touch the keychain

- **WHEN** a connection's secret has been read once in the current process via `connections.getSecret` or any internal `secrets::get`
- **AND** another caller invokes the same `secrets::get` for the same id
- **THEN** the cached value is returned without invoking the OS keychain

#### Scenario: First read populates the cache

- **WHEN** a connection has a secret stored in the keychain and the cache has no entry for its id
- **AND** any caller invokes `secrets::get` for that id
- **THEN** the keychain is read exactly once, the result is stored in the cache, and the value is returned

#### Scenario: Negative caching for connections without a secret

- **WHEN** a connection exists but has no secret stored in the keychain
- **AND** `secrets::get` is invoked for its id and returns `null`
- **AND** `secrets::get` is invoked again for the same id
- **THEN** the second call returns `null` without invoking the OS keychain

#### Scenario: Cache does not survive a process restart

- **WHEN** the application is closed and relaunched
- **AND** any caller invokes `secrets::get` for a previously-cached id
- **THEN** the keychain is read fresh and the cache is repopulated from the keychain result

### Requirement: Refresh secret

The platform SHALL expose a Tauri command `connections.refreshSecret` that evicts any cached value for the given connection id, reads the secret fresh from the OS keychain, repopulates the cache with the new value, and returns the secret string (or `null` if no secret is stored). This command is the supported way to recover from a secret that has been mutated outside Argus (for example, edited directly in macOS Keychain Access) without restarting the application.

#### Scenario: Refresh after external keychain edit

- **WHEN** a connection's secret has been cached as value `A`
- **AND** the user edits the secret in the OS keychain directly so the keychain now stores value `B`
- **AND** a caller invokes `connections.refreshSecret` with that connection's id
- **THEN** the command returns `B` and subsequent `connections.getSecret` calls return `B` from the cache

#### Scenario: Refresh of a connection without a secret

- **WHEN** a caller invokes `connections.refreshSecret` for a connection that exists but has no secret stored
- **THEN** the command returns `null` and the cache holds `null` for that id

#### Scenario: Refresh of an unknown id

- **WHEN** a caller invokes `connections.refreshSecret` for an id that does not exist in the connections table
- **THEN** the command returns `AppError::NotFound`

