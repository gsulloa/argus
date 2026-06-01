## ADDED Requirements

### Requirement: MySQL connection params shape

The MySQL module SHALL define and own a typed params shape: `{ host: string, port: u16, database: string, username: string, ssl_mode: "disabled"|"preferred"|"required"|"verify-ca"|"verify-identity", read_only: boolean }`. When a connection is created or updated with `kind: "mysql"`, the MySQL module MUST validate the params before persistence and reject invalid values with `AppError::Validation`. The platform's `connection-registry` continues to treat `params` as opaque JSON; only the MySQL module reads it.

#### Scenario: Valid params round-trip

- **WHEN** the user creates a MySQL connection with `host: "db.local"`, `port: 3306`, `database: "analytics"`, `username: "ana"`, `ssl_mode: "required"`, `read_only: false`
- **THEN** the connection is persisted via `connections.create` and `connections.list` returns the same params shape

#### Scenario: Empty host rejected

- **WHEN** the user submits a MySQL params object with `host: ""` (empty or whitespace only)
- **THEN** the MySQL module returns `AppError::Validation` and no row is created

#### Scenario: Out-of-range port rejected

- **WHEN** the user submits a MySQL params object with `port: 0` or `port: 70000`
- **THEN** the MySQL module returns `AppError::Validation` and no row is created

#### Scenario: Unknown ssl_mode rejected

- **WHEN** the user submits a MySQL params object with `ssl_mode: "allow"` (a value not in the supported enum)
- **THEN** the MySQL module returns `AppError::Validation` with a message naming the supported values

#### Scenario: read_only defaults to false

- **WHEN** the user submits MySQL params without an explicit `read_only` field
- **THEN** the persisted row has `read_only: false`

### Requirement: MySQL connection URL parsing

The MySQL module SHALL expose a pure function `parseMysqlUrl(url: string)` that accepts `mysql://` and `mariadb://` URLs and returns `{ params: MysqlParams, password?: string }`. The function MUST URL-decode user info, default the port to `3306` when absent, and map the `ssl-mode` (or `sslMode`) query parameter to the typed enum. It MUST return a typed error for malformed URLs or unknown `ssl-mode` values.

#### Scenario: Full URL parses

- **WHEN** the user pastes `mysql://ana:s3cret@db.local:3307/analytics?ssl-mode=REQUIRED`
- **THEN** `parseMysqlUrl` returns params `{ host: "db.local", port: 3307, database: "analytics", username: "ana", ssl_mode: "required", read_only: false }` and `password: "s3cret"`

#### Scenario: mariadb scheme parses

- **WHEN** the user pastes `mariadb://ana@db.local:3306/analytics?ssl-mode=PREFERRED`
- **THEN** `parseMysqlUrl` returns params `{ host: "db.local", port: 3306, database: "analytics", username: "ana", ssl_mode: "preferred", read_only: false }`

#### Scenario: Missing port defaults to 3306

- **WHEN** the user pastes `mysql://ana@db.local/analytics`
- **THEN** the returned params have `port: 3306`

#### Scenario: URL-encoded credentials are decoded

- **WHEN** the user pastes `mysql://us%40r:p%2Fss@db.local/analytics`
- **THEN** the returned `username` is `us@r` and the returned `password` is `p/ss`

#### Scenario: sslMode camelCase query param accepted

- **WHEN** the user pastes `mysql://ana@db.local/analytics?sslMode=verify-identity`
- **THEN** the returned params have `ssl_mode: "verify-identity"`

#### Scenario: Malformed URL rejected

- **WHEN** the user pastes a string that is not a valid URL (for example `not-a-url`)
- **THEN** `parseMysqlUrl` returns a typed error and the form shows a clear message

#### Scenario: Unknown ssl-mode in URL rejected

- **WHEN** the user pastes a URL with `?ssl-mode=allow`
- **THEN** `parseMysqlUrl` returns a typed error naming the supported `ssl-mode` values

### Requirement: Test connection command

The MySQL module SHALL expose a Tauri command `mysql.testConnection(params, secret?)` that opens a single MySQL connection (no pool), runs `SELECT VERSION()`, closes it, and returns either `{ ok: true, latencyMs: number, serverVersion: string }` or `{ ok: false, error: AppError }`. The command MUST honor `ssl_mode` for TLS behavior, MUST timeout after 8 seconds total, and MUST NOT persist anything. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "test_connection"`, `connection_id: null`, `origin: "user"`, `duration_ms` measuring the wall time spent in the command, `sql: null`, `params: null`, `metric: { kind: "server_version", value: serverVersion }` on success or `null` on failure, and `status` matching the result.

#### Scenario: Successful test against a reachable MySQL server

- **WHEN** the user fills the form for a reachable MySQL instance and clicks "Test"
- **THEN** the command returns `{ ok: true, latencyMs: <measured>, serverVersion: "8.0.36" }` within the timeout

#### Scenario: Successful test against a reachable MariaDB server

- **WHEN** the user fills the form for a reachable MariaDB instance and clicks "Test"
- **THEN** the command returns `{ ok: true, latencyMs: <measured>, serverVersion: "10.11.6-MariaDB" }` within the timeout

#### Scenario: Wrong password reported as MySQL error

- **WHEN** the user tests a connection whose password is incorrect
- **THEN** the command returns `{ ok: false, error: AppError::Mysql }` with the SQLSTATE for access-denied (`28000`) preserved in the error code

#### Scenario: Unreachable host reported as MySQL error without code

- **WHEN** the user tests a connection whose host does not resolve
- **THEN** the command returns `{ ok: false, error: AppError::Mysql }` with `code: null` and a message indicating DNS or connect failure

#### Scenario: Connection refused reported with HY000-class code

- **WHEN** the user tests a connection whose host resolves but TCP connect is refused
- **THEN** the command returns `{ ok: false, error: AppError::Mysql }` with `code: "08001"` and a message describing the connect failure

#### Scenario: Timeout after 8 seconds

- **WHEN** the test takes longer than 8 seconds (network silently drops packets)
- **THEN** the command returns `{ ok: false, error: AppError::Mysql }` with a timeout message

#### Scenario: Test does not persist anything

- **WHEN** the user runs `mysql.testConnection` for a not-yet-saved form
- **AND** the user subsequently calls `connections.list`
- **THEN** the list does not contain a record for the tested params

#### Scenario: Successful test emits an activity-log entry

- **WHEN** the user runs `mysql.testConnection` and it succeeds
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "test_connection"`, `status: "ok"`, `metric: { kind: "server_version", value: <returned serverVersion> }`, `connection_id: null`

#### Scenario: Failing test emits an activity-log entry with error

- **WHEN** the user runs `mysql.testConnection` and the server rejects the password
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "test_connection"`, `status: "err"`, `error.code: "28000"`, `metric: null`

### Requirement: Connect command and pool registry

The MySQL module SHALL expose a Tauri command `mysql.connect(connectionId)` that loads the params and secret for the given id, builds a `sqlx::MySqlPool` with min=1, max=4, eagerly fetches one connection to verify the handshake (running `SELECT VERSION()`), and registers the pool in a backend `MysqlPoolRegistry` keyed by connection id. If a pool already exists for the id, the existing pool MUST be returned without rebuilding. On success the command returns `{ serverVersion: string, readOnly: boolean }`. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "connect"`, `connection_id: <id>`, `origin: "user"`, `sql: null`, `params: null`, `metric: { kind: "server_version", value: serverVersion }` on success (`null` on failure), `status` matching the result, and `duration_ms` covering the entire command.

#### Scenario: Connect succeeds and exposes server version

- **WHEN** the user invokes `mysql.connect(id)` for a valid MySQL connection
- **THEN** the command returns `{ serverVersion: "8.0.36", readOnly: false }` and the pool is now registered under `id`

#### Scenario: Idempotent connect

- **WHEN** the user invokes `mysql.connect(id)` for an id that already has a registered pool
- **THEN** the command returns the same `{ serverVersion, readOnly }` without rebuilding the pool

#### Scenario: Connect with handshake failure returns AppError

- **WHEN** the user invokes `mysql.connect(id)` and the handshake fails (auth, TLS, network)
- **THEN** the command returns `AppError::Mysql` and no pool is registered under `id`

#### Scenario: Connect for unknown id

- **WHEN** the user invokes `mysql.connect(id)` for an id not present in the connections table
- **THEN** the command returns `AppError::NotFound` and no pool is registered

#### Scenario: Successful connect emits an activity-log entry

- **WHEN** `mysql.connect(id)` succeeds
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "connect"`, `status: "ok"`, `connection_id: <id>`, `origin: "user"`, `metric: { kind: "server_version", value: <returned serverVersion> }`

#### Scenario: Failing connect emits an activity-log entry with error

- **WHEN** `mysql.connect(id)` fails because the host is unreachable
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "connect"`, `status: "err"`, `connection_id: <id>`, `metric: null`, `error.message` describing the failure

### Requirement: Disconnect command

The MySQL module SHALL expose a Tauri command `mysql.disconnect(connectionId)` that removes the pool registered under the given id from the registry. Idle connections in the pool MUST be closed; in-flight queries MUST be allowed to complete. Disconnecting an id that has no registered pool MUST return success silently. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "disconnect"`, `connection_id: <id>`, `origin: "user"`, `sql: null`, `params: null`, `metric: null`, `status: "ok"`, and `duration_ms` covering the command.

#### Scenario: Disconnecting an active connection

- **WHEN** the user invokes `mysql.disconnect(id)` for an id that has a registered pool
- **THEN** the pool is removed from the registry and `mysql.listActive` no longer includes the id

#### Scenario: Disconnect when not connected is a no-op

- **WHEN** the user invokes `mysql.disconnect(id)` for an id that has no registered pool
- **THEN** the command returns success without error

#### Scenario: Disconnect emits an activity-log entry

- **WHEN** the user invokes `mysql.disconnect(id)`
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "disconnect"`, `status: "ok"`, `connection_id: <id>`, `origin: "user"`

### Requirement: Active connections enumeration and event

The MySQL module SHALL expose a Tauri command `mysql.listActive()` that returns the currently registered pools as `Array<{ id: UUID, serverVersion: string, readOnly: boolean, connectedAt: ISO8601 }>`. After every successful `connect` or `disconnect`, the module SHALL emit a Tauri event `mysql:active-changed` with no payload, allowing the frontend to refresh.

#### Scenario: List active is empty initially

- **WHEN** no connections have been opened in the current app session
- **THEN** `mysql.listActive` returns `[]`

#### Scenario: Connect emits active-changed

- **WHEN** the user invokes `mysql.connect(id)` and it succeeds
- **THEN** the event `mysql:active-changed` is emitted exactly once

#### Scenario: Disconnect emits active-changed

- **WHEN** the user invokes `mysql.disconnect(id)` for a registered pool
- **THEN** the event `mysql:active-changed` is emitted exactly once

### Requirement: Read-only enforcement at the module boundary

When a connection's `params.read_only` is `true`, every MySQL session acquired from its pool SHALL execute `SET SESSION TRANSACTION READ ONLY;` immediately after handshake. The MySQL module SHALL provide two execution helpers — `executeQuery` (always allowed) and `executeMutation` (rejected at the Rust boundary if the pool is read-only) — and MUST NOT expose a generic raw-pool accessor that bypasses these helpers.

`executeMutation(connection_id, sql, params)` MUST be implemented as a real, callable helper (not a stub or contract-only). It MUST:

1. Look up the pool for `connection_id` in `MysqlPoolRegistry`. Return `AppError::NotFound` if absent.
2. Check the pool's `read_only` flag BEFORE acquiring a session. If `true`, return `AppError::Validation { message: "connection is read-only" }` without dispatching any statement to the wire.
3. Acquire a session from the pool, execute the statement with bound `params`, and return the affected-row count.
4. Honor the same 15s timeout + cancel-token pattern used by `executeQuery`.

Higher-level commands that need transactional control (e.g. `mysql_apply_table_edits`) MAY acquire a session directly from the pool to manage the transaction lifetime explicitly — but MUST first perform the same `read_only` check that `executeMutation` performs.

#### Scenario: Mutation rejected before reaching the wire

- **WHEN** any module calls `executeMutation(id, "UPDATE t SET x = 1", [])` for a connection with `read_only: true`
- **THEN** the helper returns `AppError::Validation` with message `"connection is read-only"` and no SQL is sent to the server

#### Scenario: Mutation executes on writable connection

- **WHEN** any module calls `executeMutation(id, "UPDATE t SET x = ? WHERE id = ?", ["a", 1])` for a writable connection
- **THEN** the statement is dispatched, the bound parameters are used, and the helper returns the affected-row count

#### Scenario: Read query allowed on read-only connection

- **WHEN** any module calls `executeQuery(id, "SELECT 1", [])` for a connection with `read_only: true`
- **THEN** the query executes successfully

#### Scenario: Mutation rejected by server if it slips through

- **WHEN** a stored procedure or trigger fires a write on a read-only session
- **THEN** MySQL rejects it with SQLSTATE `25006` (cannot execute statement in a read-only transaction) and the error surfaces as `AppError::Mysql` with that code

#### Scenario: Transactional caller skips executeMutation but still checks read-only

- **WHEN** `mysql_apply_table_edits` runs against a connection with `read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }` BEFORE any `START TRANSACTION` is dispatched

### Requirement: Error code mapping

The MySQL module SHALL surface server errors as `AppError::Mysql { code: Option<String>, message: String }`, where `code` carries the 5-character SQLSTATE returned by the server when available. Network and DNS failures that occur before any SQLSTATE is exchanged MUST set `code: null`. Connection refused at the TCP layer MUST be reported with SQLSTATE `08001`. Authentication failures MUST be reported with SQLSTATE `28000` (access denied). Query interruption (server-side cancel via `KILL QUERY <connection-id>`) MUST be reported with SQLSTATE `70100` (query interrupted). Syntax errors MUST be reported with SQLSTATE `42000`. Generic server errors with no specific SQLSTATE MUST be reported with `HY000`.

#### Scenario: Access denied surfaces 28000

- **WHEN** a command receives a MySQL access-denied error from the server
- **THEN** the resulting `AppError::Mysql` has `code: "28000"` and a message that does not embed the password

#### Scenario: Cancelled query surfaces 70100

- **WHEN** a long-running query is cancelled via `KILL QUERY <connection-id>`
- **THEN** the resulting `AppError::Mysql` has `code: "70100"`

#### Scenario: Read-only transaction violation surfaces 25006

- **WHEN** a statement writes on a session that has executed `SET SESSION TRANSACTION READ ONLY`
- **THEN** the resulting `AppError::Mysql` has `code: "25006"`

#### Scenario: TCP connect refused surfaces 08001

- **WHEN** the server's host resolves but no process is listening on the port
- **THEN** the resulting `AppError::Mysql` has `code: "08001"`

#### Scenario: DNS failure surfaces null code

- **WHEN** the server's host does not resolve
- **THEN** the resulting `AppError::Mysql` has `code: null`

### Requirement: TLS modes and trust roots

The MySQL module SHALL negotiate TLS via `sqlx`'s `runtime-tokio-rustls` runtime backed by the bundled Mozilla root certificates. The `ssl_mode` enum SHALL drive TLS behavior as follows: `"disabled"` MUST disable TLS entirely; `"preferred"` MUST attempt TLS opportunistically and fall back to plaintext if unavailable, with no certificate verification; `"required"` MUST require TLS but perform no certificate verification; `"verify-ca"` MUST require TLS and verify the server certificate against the bundled CA roots without checking the hostname; `"verify-identity"` MUST require TLS, verify against the bundled CA roots, and additionally verify that the server certificate's subject matches the connection host.

#### Scenario: disabled mode connects without TLS

- **WHEN** a connection is opened with `ssl_mode: "disabled"`
- **THEN** the wire protocol is plain text and no `SSLRequest` packet is sent

#### Scenario: required mode skips verification

- **WHEN** a connection is opened with `ssl_mode: "required"` against a server presenting a self-signed certificate
- **THEN** the handshake succeeds and the session is encrypted

#### Scenario: verify-ca rejects untrusted certificate

- **WHEN** a connection is opened with `ssl_mode: "verify-ca"` against a server whose certificate is not signed by a bundled root
- **THEN** the handshake fails with `AppError::Mysql` carrying a TLS-verification message

#### Scenario: verify-identity rejects hostname mismatch

- **WHEN** a connection is opened with `ssl_mode: "verify-identity"` to host `db.local` against a server whose certificate's subject is `other.local` (but is signed by a bundled root)
- **THEN** the handshake fails with `AppError::Mysql` carrying a hostname-verification message

### Requirement: Connection form

The frontend SHALL provide a MySQL connection form, opened from the sidebar "+" button and from the `Connection: New MySQL…` palette command. The form MUST present two views switchable by a tab control: a "Form" view with fields `name`, `host`, `port` (defaulting to `3306`), `database`, `username`, `password`, `ssl_mode`, `read_only`; and a "URL" view with a single text input plus a "Parse" button that fills the form fields and switches to the form view. The form MUST expose a "Test" button that invokes `mysql.testConnection` and shows the typed result inline, and "Save" / "Save & Connect" buttons that persist via `connections.create` (or `connections.update` in edit mode).

#### Scenario: Filling and saving a connection

- **WHEN** the user opens the form, fills valid fields, clicks "Save"
- **THEN** a row is created via `connections.create`, the dialog closes, and the connection appears in the sidebar

#### Scenario: Port defaults to 3306

- **WHEN** the user opens the form without prefilled values
- **THEN** the port field is prefilled with `3306`

#### Scenario: Pasting a mysql:// URL fills the form

- **WHEN** the user pastes a `mysql://` URL in the URL view and clicks "Parse"
- **THEN** the form view becomes active with all parsed fields prefilled, and the password field contains the decoded password from the URL

#### Scenario: Pasting a mariadb:// URL fills the form

- **WHEN** the user pastes a `mariadb://` URL in the URL view and clicks "Parse"
- **THEN** the form view becomes active with all parsed fields prefilled

#### Scenario: Test result shown inline

- **WHEN** the user clicks "Test" with valid form fields
- **THEN** the form shows either a green success row with `serverVersion` and `latencyMs`, or a red error row with the `AppError` message

#### Scenario: Save & Connect

- **WHEN** the user clicks "Save & Connect" with valid form fields
- **THEN** the connection is persisted, the dialog closes, `mysql.connect(id)` is invoked, and the sidebar reflects the connection as active

#### Scenario: Editing leaves the password unchanged when blank

- **WHEN** the user opens the form in edit mode, modifies `name`, leaves the password field empty, and clicks "Save"
- **THEN** `connections.update` is called with no `secret` field, the keychain entry is untouched, and the row is updated

### Requirement: Sidebar MySQL connection rows

The sidebar's "Connections" section SHALL render each MySQL connection as a row containing a `MysqlIcon`, the connection name, a status indicator (green dot when `useActiveConnections()` reports the id as connected, neutral dot when inactive, spinner while a connect call is in flight), and an "RO" badge when `params.read_only` is true.

The row's primary click handler SHALL behave as follows: on an inactive row it initiates `mysql.connect`; on a row whose connection is in flight (`mysql.connect` not yet resolved) it is a no-op; on an active row it performs no destructive action (no-op or non-destructive subtree affordance). The row click MUST NOT dispatch `mysql.disconnect`.

Disconnect MUST be reachable only from a dedicated `⏻` (power) button rendered on every active row, always visible (not hover-only) and sized to be a deliberate target distinct from the row body, or from the row's right-click context menu's `Disconnect` entry, or from the section-level "Disconnect all" affordance.

Right-clicking a row opens a context menu. On an active row the menu includes `New SQL Query`, `Disconnect`, then a separator, then `Edit`, `Duplicate`, and `Delete`. On an inactive row the menu includes only `Edit`, `Duplicate`, and `Delete`.

#### Scenario: Click on an inactive row connects

- **WHEN** the user clicks an inactive MySQL connection row
- **THEN** `mysql.connect(id)` is invoked; on success the active indicator turns green

#### Scenario: Click on an active row does not disconnect

- **WHEN** the user clicks the body of a MySQL connection row whose connection is currently active
- **THEN** no `mysql.disconnect` command is dispatched and the active state of the connection is unchanged

#### Scenario: Click on a connecting row does not disconnect or re-connect

- **WHEN** the user clicks the body of a MySQL connection row while `mysql.connect` for that row is still pending
- **THEN** no additional `mysql.connect` or `mysql.disconnect` is dispatched until the in-flight call resolves

#### Scenario: Disconnect button is always visible on active rows

- **WHEN** any MySQL connection is active in the sidebar
- **THEN** that row renders a `⏻` button regardless of hover state, with a `title`/`aria-label` of "Disconnect"

#### Scenario: Disconnect button is hidden on inactive rows

- **WHEN** a MySQL connection is not active
- **THEN** the row does not render a `⏻` button

#### Scenario: RO badge visible when read-only

- **WHEN** a MySQL connection has `params.read_only: true`
- **THEN** the row displays an "RO" badge next to the name

#### Scenario: Right-click context menu on active row

- **WHEN** the user right-clicks an active MySQL connection row
- **THEN** a menu appears with `New SQL Query`, `Disconnect`, `Edit`, `Duplicate`, and `Delete`; choosing `Edit` opens the form prefilled with the connection's params and an empty password field

#### Scenario: Right-click context menu on inactive row

- **WHEN** the user right-clicks an inactive MySQL connection row
- **THEN** a menu appears with `Edit`, `Duplicate`, and `Delete`

#### Scenario: Delete confirmation

- **WHEN** the user chooses `Delete` from the context menu and confirms
- **THEN** `connections.delete(id)` is invoked, the row disappears, and any active pool for that id is dropped via `mysql.disconnect`

### Requirement: Disconnect requires a confirmation step

Activating the per-row `⏻` Disconnect button SHALL open a confirmation dialog before any `mysql.disconnect` is dispatched. The dialog MUST always be shown (it MUST NOT be skipped when there is no apparent state at risk). The dialog body MUST adapt to what is open for that connection at the moment the dialog opens:

- A "Disconnect `<name>`?" heading line is always present.
- When one or more tabs belong to that connection, a "N tab(s) will close." line is shown with the exact count.
- When one or more dirty edit buffers belong to that connection, a strong-warning line "M unsaved edit(s) will be discarded:" is shown followed by the list of affected `<table>` names. The strong-warning line MUST be visually distinct from the tab-count line.

The dialog footer MUST present a non-destructive Cancel action and a destructive-styled Disconnect action. Cancel MUST close the dialog without dispatching any command. Disconnect MUST dispatch `mysql.disconnect(connectionId)` and close the dialog.

The dialog MUST source the dirty-buffer summary from the same registry that gates per-tab close confirmation; a tab whose close confirmation reports clean MUST NOT contribute a "unsaved edit" line.

#### Scenario: Confirm shows even with nothing at risk

- **WHEN** the user clicks `⏻` on an active MySQL connection that has zero open tabs and zero dirty buffers
- **THEN** the confirmation dialog opens with only the heading line and a [Cancel] [Disconnect] footer
- **AND** no `mysql.disconnect` is dispatched until Disconnect is clicked

#### Scenario: Confirm lists tab count when tabs are open

- **WHEN** the user clicks `⏻` on a MySQL connection that has 3 open tabs and zero dirty buffers
- **THEN** the dialog body includes a line stating "3 tabs will close."

#### Scenario: Confirm warns and names tables when buffers are dirty

- **WHEN** the user clicks `⏻` on a MySQL connection that has 2 open tabs, of which 1 has a dirty edit buffer for the `users` table
- **THEN** the dialog body includes "2 tabs will close." and a separate strong-warning line "1 unsaved edit will be discarded:" followed by `users`

#### Scenario: Cancel does not disconnect

- **WHEN** the confirmation dialog is open and the user clicks Cancel
- **THEN** no `mysql.disconnect` is dispatched and the dialog closes

#### Scenario: Disconnect proceeds and closes the dialog

- **WHEN** the confirmation dialog is open and the user clicks Disconnect
- **THEN** `mysql.disconnect(connectionId)` is dispatched exactly once and the dialog closes

### Requirement: Connecting visual state ignores further clicks

While `mysql.connect` is in flight for a given connection row, the row SHALL display a busy indicator in place of the active dot (a spinner or equivalent) and its primary click handler MUST be a no-op. The busy state begins when `mysql.connect` is dispatched and ends when the promise resolves or rejects.

#### Scenario: Connecting row shows a busy indicator

- **WHEN** the user clicks an inactive MySQL connection row and `mysql.connect` is dispatched
- **THEN** until the call resolves, the row's active dot is replaced with a busy indicator

#### Scenario: Click during connecting is a no-op

- **WHEN** the user clicks the body of a row that is in the connecting state
- **THEN** no additional `mysql.connect` or `mysql.disconnect` is dispatched

### Requirement: Disconnect-all command and trigger

The sidebar Connections section header SHALL render a "Disconnect all" affordance that is visible only when at least one connection is active. Activating it MUST open the same confirmation dialog defined for per-row disconnect, with the body aggregating across every active connection: total connection count, total tab count across those connections, and a strong-warning line when any of those tabs has a dirty edit buffer (listing each affected `<connection>.<table>` pair).

The MySQL module SHALL expose a Tauri command `mysql.disconnect_all()` that snapshots the set of currently active MySQL pool ids under the registry's write lock, removes all of them, and returns the number of pools that were dropped. After the command completes the module SHALL emit exactly one `mysql:active-changed` event and exactly one `argus:activity-log` event with `kind: "disconnect"`, `connection_id: null`, `origin: "user"`, `status: "ok"`, `duration_ms` covering the whole command, `sql: null`, `params: null`, and a metric describing the count of dropped pools.

The frontend "Disconnect all" Disconnect action MUST dispatch `mysql.disconnect_all()` once rather than looping per-id `mysql.disconnect` calls (when scoped to MySQL).

#### Scenario: Disconnect-all affordance hidden when no connection is active

- **WHEN** zero MySQL connections are active
- **THEN** the Connections section header does not render a Disconnect-all affordance for MySQL

#### Scenario: Disconnect-all affordance visible when one or more are active

- **WHEN** at least one MySQL connection is active
- **THEN** the Connections section header renders a Disconnect-all affordance with a `title`/`aria-label` of "Disconnect all"

#### Scenario: Disconnect-all dialog aggregates counts

- **WHEN** the user activates Disconnect-all with 3 active MySQL connections that together have 5 open tabs and 1 dirty buffer for `analytics.users`
- **THEN** the confirmation dialog shows the connection count, "5 tabs will close.", and a strong-warning line listing `analytics.users`

#### Scenario: Disconnect-all dispatches one command

- **WHEN** the user confirms the Disconnect-all dialog with 3 active MySQL connections
- **THEN** exactly one `mysql.disconnect_all()` Tauri command is dispatched
- **AND** zero per-id `mysql.disconnect()` commands are dispatched as part of this gesture

#### Scenario: disconnect_all removes all pools

- **WHEN** the backend receives `mysql.disconnect_all()` with 3 registered pools
- **THEN** all 3 pools are removed from `MysqlPoolRegistry` and `mysql.list_active()` subsequently returns an empty list

#### Scenario: disconnect_all emits one active-changed event

- **WHEN** `mysql.disconnect_all()` completes successfully with N ≥ 1 pools dropped
- **THEN** exactly one `mysql:active-changed` event is emitted

#### Scenario: disconnect_all emits one activity-log entry

- **WHEN** `mysql.disconnect_all()` completes with N pools dropped
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "disconnect"`, `status: "ok"`, `connection_id: null`, and a metric whose value equals N

#### Scenario: disconnect_all with no active pools is a no-op

- **WHEN** `mysql.disconnect_all()` is invoked while `MysqlPoolRegistry` is empty
- **THEN** the command returns 0, no `mysql:active-changed` event is emitted, and no `argus:activity-log` event is emitted

### Requirement: Palette commands for MySQL connections

The MySQL module SHALL register the following commands in the `command-palette` registry on app start. `Connection: New MySQL…` is MySQL-specific and opens the MySQL connection form. `Connection: Test…`, `Connection: Connect…`, and `Connection: Disconnect…` are shared, driver-agnostic palette commands registered by the platform; when invoked against a focused MySQL row (or after the chooser selects a MySQL connection) they MUST route to `mysql.testConnection`, `mysql.connect`, and `mysql.disconnect` respectively.

#### Scenario: New MySQL command opens the form

- **WHEN** the user opens the palette and activates `Connection: New MySQL…`
- **THEN** the MySQL connection form opens in "Form" view with empty fields (port prefilled to `3306`)

#### Scenario: Test command without a selection shows a chooser

- **WHEN** the user activates `Connection: Test…` with no sidebar selection
- **THEN** the palette transitions to a chooser listing existing connections; selecting a MySQL connection runs `mysql.testConnection`

#### Scenario: Connect command routes to mysql.connect for a focused MySQL row

- **WHEN** the user focuses a MySQL row in the sidebar and activates `Connection: Connect…`
- **THEN** `mysql.connect(id)` is dispatched for that row

#### Scenario: Disconnect command routes to mysql.disconnect for a focused MySQL row

- **WHEN** the user focuses an active MySQL row in the sidebar and activates `Connection: Disconnect…`
- **THEN** the disconnect-confirmation dialog opens and, on confirm, `mysql.disconnect(id)` is dispatched for that row

### Requirement: MySQL icon visual identity

The `MysqlIcon` component exported from `src/modules/mysql/index.ts` SHALL render an organic, rounded silhouette that reads as a dolphin profile (head with a clearly identifiable beak/rostrum and a curved dorsal fin), designed so that at 14px (the sidebar connection-row size) it is unambiguously distinguishable from the `PostgresIcon` (elephant) and `DynamoIcon` (stacked cylinders) silhouettes without color cues.

The icon MUST:
- Use a 24×24 viewBox.
- Use hairline strokes only (`stroke-width` 1.5, `stroke="currentColor"`, no `fill` other than `currentColor` on tiny detail nodes ≤1px radius such as the eye).
- Inherit color via `currentColor`. The component MUST NOT hardcode any color value, gradient, brand color, or duotone fill.
- Expose the same component contract as the other driver icons: a named export `MysqlIcon` accepting `{ size?: number; className?: string }` with `size` defaulting to 16.
- Carry `role="img"` and `aria-label="MySQL"` on the root `<svg>`.

The silhouette's primary shape category SHALL be "rounded organic profile with a clearly identifiable elongated beak/rostrum and a curved dorsal fin rising from the back" — it MUST NOT be a rectangle, a rounded rectangle, a cylinder, a stack of horizontal bands, a hexagon, or any other primarily-geometric form, and it MUST NOT collide visually with the elephant trunk silhouette used by `PostgresIcon`.

#### Scenario: Sidebar shows the icon at 14px next to Postgres and DynamoDB rows

- **WHEN** the sidebar's Connections section renders a MySQL row, a Postgres row, and a DynamoDB row at the default 14px icon size
- **THEN** the MySQL row's icon presents the dolphin silhouette, the Postgres row's icon presents the elephant head-and-trunk silhouette, and the DynamoDB row's icon presents the stacked-cylinder silhouette, and a user can identify each row's kind by icon alone (no name, no badge) at normal reading distance

#### Scenario: Icon inherits muted text color

- **WHEN** `MysqlIcon` is rendered inside the sidebar where the parent applies `color: var(--text-muted)`
- **THEN** every stroked path and any tiny filled detail node in the SVG renders in the muted text color, with no hardcoded color string anywhere in the component

#### Scenario: Icon component contract is preserved

- **WHEN** a caller renders `<MysqlIcon />`, `<MysqlIcon size={14} />`, `<MysqlIcon size={20} />`, or `<MysqlIcon className="foo" />`
- **THEN** the SVG renders at the requested square size (defaulting to 16), applies the optional className to the root `<svg>`, and exposes `role="img"` with `aria-label="MySQL"`
