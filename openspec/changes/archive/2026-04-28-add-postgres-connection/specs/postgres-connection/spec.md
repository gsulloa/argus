## ADDED Requirements

### Requirement: Postgres connection params shape

The Postgres module SHALL define and own a typed params shape: `{ host: string, port: u16, database: string, username: string, sslmode: "disable"|"prefer"|"require"|"verify-ca"|"verify-full", application_name?: string, read_only: boolean }`. When a connection is created or updated with `kind: "postgres"`, the Postgres module MUST validate the params before persistence and reject invalid values with `AppError::Validation`. The platform's `connection-registry` continues to treat `params` as opaque JSON; only the Postgres module reads it.

#### Scenario: Valid params round-trip

- **WHEN** the user creates a Postgres connection with `host: "db.local"`, `port: 5432`, `database: "analytics"`, `username: "ana"`, `sslmode: "require"`, `application_name: "argus"`, `read_only: false`
- **THEN** the connection is persisted via `connections.create` and `connections.list` returns the same params shape

#### Scenario: Empty host rejected

- **WHEN** the user submits a Postgres params object with `host: ""` (empty or whitespace only)
- **THEN** the Postgres module returns `AppError::Validation` and no row is created

#### Scenario: Out-of-range port rejected

- **WHEN** the user submits a Postgres params object with `port: 0` or `port: 70000`
- **THEN** the Postgres module returns `AppError::Validation` and no row is created

#### Scenario: Unknown sslmode rejected

- **WHEN** the user submits a Postgres params object with `sslmode: "allow"` (a libpq value not in the supported enum)
- **THEN** the Postgres module returns `AppError::Validation` with a message naming the supported values

#### Scenario: read_only defaults to false

- **WHEN** the user submits Postgres params without an explicit `read_only` field
- **THEN** the persisted row has `read_only: false`

### Requirement: Postgres connection URL parsing

The Postgres module SHALL expose a pure function `parsePostgresUrl(url: string)` that accepts `postgresql://` and `postgres://` URLs and returns `{ params: PostgresParams, password?: string }`. The function MUST URL-decode user info, default the port to `5432` when absent, map the `sslmode` query parameter to the typed enum, copy `application_name` from query params, and return a typed error for malformed URLs or unknown `sslmode` values.

#### Scenario: Full URL parses

- **WHEN** the user pastes `postgresql://ana:s3cret@db.local:5433/analytics?sslmode=require&application_name=argus`
- **THEN** `parsePostgresUrl` returns params `{ host: "db.local", port: 5433, database: "analytics", username: "ana", sslmode: "require", application_name: "argus", read_only: false }` and `password: "s3cret"`

#### Scenario: Missing port defaults to 5432

- **WHEN** the user pastes `postgresql://ana@db.local/analytics`
- **THEN** the returned params have `port: 5432`

#### Scenario: URL-encoded credentials are decoded

- **WHEN** the user pastes `postgresql://us%40r:p%2Fss@db.local/analytics`
- **THEN** the returned `username` is `us@r` and the returned `password` is `p/ss`

#### Scenario: Malformed URL rejected

- **WHEN** the user pastes a string that is not a valid URL (for example `not-a-url`)
- **THEN** `parsePostgresUrl` returns a typed error and the form shows a clear message

#### Scenario: Unknown sslmode in URL rejected

- **WHEN** the user pastes a URL with `?sslmode=allow`
- **THEN** `parsePostgresUrl` returns a typed error naming the supported sslmode values

### Requirement: Test connection command

The Postgres module SHALL expose a Tauri command `postgres.testConnection(params, secret?)` that opens a single Postgres connection (no pool), runs `SELECT version()`, closes it, and returns either `{ ok: true, latencyMs: number, serverVersion: string }` or `{ ok: false, error: AppError }`. The command MUST honor `sslmode` for TLS behavior, MUST timeout after 8 seconds total, and MUST NOT persist anything.

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

### Requirement: Connect command and pool registry

The Postgres module SHALL expose a Tauri command `postgres.connect(connectionId)` that loads the params and secret for the given id, builds a `deadpool-postgres` pool with min=1, max=4, eagerly fetches one connection to verify the handshake, and registers the pool in a backend `PgPoolRegistry` keyed by connection id. If a pool already exists for the id, the existing pool MUST be returned without rebuilding. On success the command returns `{ serverVersion: string, readOnly: boolean }`.

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

### Requirement: Disconnect command

The Postgres module SHALL expose a Tauri command `postgres.disconnect(connectionId)` that removes the pool registered under the given id from the registry. Idle connections in the pool MUST be closed; in-flight queries MUST be allowed to complete. Disconnecting an id that has no registered pool MUST return success silently.

#### Scenario: Disconnecting an active connection

- **WHEN** the user invokes `postgres.disconnect(id)` for an id that has a registered pool
- **THEN** the pool is removed from the registry and `postgres.listActive` no longer includes the id

#### Scenario: Disconnect when not connected is a no-op

- **WHEN** the user invokes `postgres.disconnect(id)` for an id that has no registered pool
- **THEN** the command returns success without error

### Requirement: Active connections enumeration and event

The Postgres module SHALL expose a Tauri command `postgres.listActive()` that returns the currently registered pools as `Array<{ id: UUID, serverVersion: string, readOnly: boolean, connectedAt: ISO8601 }>`. After every successful `connect` or `disconnect`, the module SHALL emit a Tauri event `postgres:active-changed` with no payload, allowing the frontend to refresh.

#### Scenario: List active is empty initially

- **WHEN** no connections have been opened in the current app session
- **THEN** `postgres.listActive` returns `[]`

#### Scenario: Connect emits active-changed

- **WHEN** the user invokes `postgres.connect(id)` and it succeeds
- **THEN** the event `postgres:active-changed` is emitted exactly once

#### Scenario: Disconnect emits active-changed

- **WHEN** the user invokes `postgres.disconnect(id)` for a registered pool
- **THEN** the event `postgres:active-changed` is emitted exactly once

### Requirement: Read-only enforcement at the module boundary

When a connection's `params.read_only` is `true`, every Postgres session acquired from its pool SHALL execute `SET SESSION default_transaction_read_only = on; SET SESSION transaction_read_only = on;` immediately after handshake. The Postgres module SHALL provide two execution helpers — `executeQuery` (always allowed) and `executeMutation` (rejected at the Rust boundary if the pool is read-only) — and MUST NOT expose a generic raw-pool accessor that bypasses these helpers.

#### Scenario: Mutation rejected before reaching the wire

- **WHEN** any module calls `executeMutation(id, "UPDATE t SET x = 1", [])` for a connection with `read_only: true`
- **THEN** the helper returns `AppError::Validation` with message `"connection is read-only"` and no SQL is sent to the server

#### Scenario: Read query allowed on read-only connection

- **WHEN** any module calls `executeQuery(id, "SELECT 1", [])` for a connection with `read_only: true`
- **THEN** the query executes successfully

#### Scenario: Mutation rejected by server if it slips through

- **WHEN** a stored procedure or trigger fires a write on a read-only session
- **THEN** Postgres rejects it with SQLSTATE 25006 (`read_only_sql_transaction`) and the error surfaces as `AppError::Postgres` with that code

### Requirement: Connection form

The frontend SHALL provide a Postgres connection form, opened from the sidebar "+" button and from the `Connection: New Postgres…` palette command. The form MUST present two views switchable by a tab control: a "Form" view with fields `name`, `host`, `port`, `database`, `username`, `password`, `sslmode`, `application_name`, `read_only`; and a "URL" view with a single text input plus a "Parse" button that fills the form fields and switches to the form view. The form MUST expose a "Test" button that invokes `postgres.testConnection` and shows the typed result inline, and "Save" / "Save & Connect" buttons that persist via `connections.create` (or `connections.update` in edit mode).

#### Scenario: Filling and saving a connection

- **WHEN** the user opens the form, fills valid fields, clicks "Save"
- **THEN** a row is created via `connections.create`, the dialog closes, and the connection appears in the sidebar

#### Scenario: Pasting a URL fills the form

- **WHEN** the user pastes a `postgresql://` URL in the URL view and clicks "Parse"
- **THEN** the form view becomes active with all parsed fields prefilled, and the password field contains the decoded password from the URL

#### Scenario: Test result shown inline

- **WHEN** the user clicks "Test" with valid form fields
- **THEN** the form shows either a green success row with `serverVersion` and `latencyMs`, or a red error row with the `AppError` message

#### Scenario: Save & Connect

- **WHEN** the user clicks "Save & Connect" with valid form fields
- **THEN** the connection is persisted, the dialog closes, `postgres.connect(id)` is invoked, and the sidebar reflects the connection as active

#### Scenario: Editing leaves the password unchanged when blank

- **WHEN** the user opens the form in edit mode, modifies `name`, leaves the password field empty, and clicks "Save"
- **THEN** `connections.update` is called with no `secret` field, the keychain entry is untouched, and the row is updated

### Requirement: Sidebar Postgres connection rows

The sidebar's "Connections" section SHALL render each Postgres connection as a row containing a Postgres icon, the connection name, a green "active" indicator when `useActiveConnections()` reports the id as connected, and an "RO" badge when `params.read_only` is true. Clicking a row toggles connect/disconnect via `postgres.connect` or `postgres.disconnect`. Right-clicking a row opens a context menu with `Edit`, `Duplicate`, and `Delete`.

#### Scenario: Click toggles connect

- **WHEN** the user clicks an inactive connection row
- **THEN** `postgres.connect(id)` is invoked; on success the active indicator turns green

#### Scenario: Click toggles disconnect

- **WHEN** the user clicks an active connection row
- **THEN** `postgres.disconnect(id)` is invoked; the active indicator clears

#### Scenario: RO badge visible when read-only

- **WHEN** a connection has `params.read_only: true`
- **THEN** the row displays an "RO" badge next to the name

#### Scenario: Right-click context menu

- **WHEN** the user right-clicks a connection row
- **THEN** a menu appears with `Edit`, `Duplicate`, and `Delete`; choosing `Edit` opens the form prefilled with the connection's params and an empty password field

#### Scenario: Delete confirmation

- **WHEN** the user chooses `Delete` from the context menu and confirms
- **THEN** `connections.delete(id)` is invoked, the row disappears, and any active pool for that id is dropped via `postgres.disconnect`

### Requirement: Palette commands for Postgres connections

The Postgres module SHALL register the following commands in the `command-palette` registry on app start: `Connection: New Postgres…` (opens the form), `Connection: Test…` (tests the currently selected connection or, if none selected, opens a chooser), `Connection: Connect…` (connects the currently selected connection), and `Connection: Disconnect…` (disconnects the currently selected connection).

#### Scenario: New Postgres command opens the form

- **WHEN** the user opens the palette and activates `Connection: New Postgres…`
- **THEN** the connection form opens in "Form" view with empty fields

#### Scenario: Test command without a selection shows a chooser

- **WHEN** the user activates `Connection: Test…` with no sidebar selection
- **THEN** the palette transitions to a chooser listing existing Postgres connections, and selecting one runs the test
