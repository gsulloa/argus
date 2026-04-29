## MODIFIED Requirements

### Requirement: Test connection command

The Postgres module SHALL expose a Tauri command `postgres.testConnection(params, secret?)` that opens a single Postgres connection (no pool), runs `SELECT version()`, closes it, and returns either `{ ok: true, latencyMs: number, serverVersion: string }` or `{ ok: false, error: AppError }`. The command MUST honor `sslmode` for TLS behavior, MUST timeout after 8 seconds total, and MUST NOT persist anything. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "test_connection"`, `connection_id: null`, `origin: "user"`, `duration_ms` measuring the wall time spent in the command, `sql: null`, `params: null`, `metric: { kind: "server_version", value: serverVersion }` on success or `null` on failure, and `status` matching the result.

#### Scenario: Successful test against a reachable server

- **WHEN** the user fills the form for a reachable Postgres instance and clicks "Test"
- **THEN** the command returns `{ ok: true, latencyMs: <measured>, serverVersion: "PostgreSQL 16.x ..." }` within the timeout

#### Scenario: Wrong password reported as Postgres error

- **WHEN** the user tests a connection whose password is incorrect
- **THEN** the command returns `{ ok: false, error: AppError::Postgres }` with the SQLSTATE for invalid_password (28P01) preserved in the error code

#### Scenario: Unreachable host reported as Postgres error without code

- **WHEN** the user tests a connection whose host does not resolve
- **THEN** the command returns `{ ok: false, error: AppError::Postgres }` with `code: null` and a message indicating DNS or connect failure

#### Scenario: Timeout after 8 seconds

- **WHEN** the test takes longer than 8 seconds (network silently drops packets)
- **THEN** the command returns `{ ok: false, error: AppError::Postgres }` with a timeout message

#### Scenario: Test does not persist anything

- **WHEN** the user runs `postgres.testConnection` for a not-yet-saved form
- **AND** the user subsequently calls `connections.list`
- **THEN** the list does not contain a record for the tested params

#### Scenario: Successful test emits an activity-log entry

- **WHEN** the user runs `postgres.testConnection` and it succeeds
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "test_connection"`, `status: "ok"`, `metric: { kind: "server_version", value: <returned serverVersion> }`, `connection_id: null`

#### Scenario: Failing test emits an activity-log entry with error

- **WHEN** the user runs `postgres.testConnection` and the server rejects the password
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "test_connection"`, `status: "err"`, `error.code: "28P01"`, `metric: null`

### Requirement: Connect command and pool registry

The Postgres module SHALL expose a Tauri command `postgres.connect(connectionId)` that loads the params and secret for the given id, builds a `deadpool-postgres` pool with min=1, max=4, eagerly fetches one connection to verify the handshake, and registers the pool in a backend `PgPoolRegistry` keyed by connection id. If a pool already exists for the id, the existing pool MUST be returned without rebuilding. On success the command returns `{ serverVersion: string, readOnly: boolean }`. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "connect"`, `connection_id: <id>`, `origin: "user"`, `sql: null`, `params: null`, `metric: { kind: "server_version", value: serverVersion }` on success (`null` on failure), `status` matching the result, and `duration_ms` covering the entire command.

#### Scenario: Connect succeeds and exposes server version

- **WHEN** the user invokes `postgres.connect(id)` for a valid Postgres connection
- **THEN** the command returns `{ serverVersion: "PostgreSQL 16.x ...", readOnly: false }` and the pool is now registered under `id`

#### Scenario: Idempotent connect

- **WHEN** the user invokes `postgres.connect(id)` for an id that already has a registered pool
- **THEN** the command returns the same `{ serverVersion, readOnly }` without rebuilding the pool

#### Scenario: Connect with handshake failure returns AppError

- **WHEN** the user invokes `postgres.connect(id)` and the handshake fails (auth, TLS, network)
- **THEN** the command returns `AppError::Postgres` and no pool is registered under `id`

#### Scenario: Connect for unknown id

- **WHEN** the user invokes `postgres.connect(id)` for an id not present in the connections table
- **THEN** the command returns `AppError::NotFound` and no pool is registered

#### Scenario: Successful connect emits an activity-log entry

- **WHEN** `postgres.connect(id)` succeeds
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "connect"`, `status: "ok"`, `connection_id: <id>`, `origin: "user"`, `metric: { kind: "server_version", value: <returned serverVersion> }`

#### Scenario: Failing connect emits an activity-log entry with error

- **WHEN** `postgres.connect(id)` fails because the host is unreachable
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "connect"`, `status: "err"`, `connection_id: <id>`, `metric: null`, `error.message` describing the failure

### Requirement: Disconnect command

The Postgres module SHALL expose a Tauri command `postgres.disconnect(connectionId)` that removes the pool registered under the given id from the registry. Idle connections in the pool MUST be closed; in-flight queries MUST be allowed to complete. Disconnecting an id that has no registered pool MUST return success silently. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "disconnect"`, `connection_id: <id>`, `origin: "user"`, `sql: null`, `params: null`, `metric: null`, `status: "ok"`, and `duration_ms` covering the command.

#### Scenario: Disconnecting an active connection

- **WHEN** the user invokes `postgres.disconnect(id)` for an id that has a registered pool
- **THEN** the pool is removed from the registry and `postgres.listActive` no longer includes the id

#### Scenario: Disconnect when not connected is a no-op

- **WHEN** the user invokes `postgres.disconnect(id)` for an id that has no registered pool
- **THEN** the command returns success without error

#### Scenario: Disconnect emits an activity-log entry

- **WHEN** the user invokes `postgres.disconnect(id)`
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "disconnect"`, `status: "ok"`, `connection_id: <id>`, `origin: "user"`
