# mssql-connection Specification

## Purpose
TBD - created by archiving change add-mssql-support. Update Purpose after archive.
## Requirements
### Requirement: MS SQL Server connection params shape

The MS SQL Server module SHALL define and own a typed params shape: `{ host: string, port: u16, database: string, username: string, encrypt: "off"|"on"|"strict", trust_server_certificate: boolean, read_only: boolean, instance_name?: string, application_intent?: "read-write"|"read-only" }`. When a connection is created or updated with `kind: "mssql"`, the MS SQL Server module MUST validate the params before persistence and reject invalid values with `AppError::Validation`. The platform's `connection-registry` continues to treat `params` as opaque JSON; only the MS SQL Server module reads it.

Authentication is SQL Authentication only in v1: the params carry a `username` field and the keychain carries the matching password. Windows Authentication, Azure AD / Entra ID, and Managed Identity are explicitly out of scope and the params shape MUST NOT carry fields for them.

#### Scenario: Valid params round-trip

- **WHEN** the user creates a MS SQL Server connection with `host: "db.local"`, `port: 1433`, `database: "Analytics"`, `username: "sa"`, `encrypt: "on"`, `trust_server_certificate: false`, `read_only: false`
- **THEN** the connection is persisted via `connections.create` and `connections.list` returns the same params shape

#### Scenario: Empty host rejected

- **WHEN** the user submits a MS SQL Server params object with `host: ""` (empty or whitespace only)
- **THEN** the MS SQL Server module returns `AppError::Validation` and no row is created

#### Scenario: Empty database rejected

- **WHEN** the user submits a MS SQL Server params object with `database: ""` (empty or whitespace only)
- **THEN** the MS SQL Server module returns `AppError::Validation` and no row is created

#### Scenario: Out-of-range port rejected

- **WHEN** the user submits a MS SQL Server params object with `port: 0` or `port: 70000`
- **THEN** the MS SQL Server module returns `AppError::Validation` and no row is created

#### Scenario: Unknown encrypt mode rejected

- **WHEN** the user submits a MS SQL Server params object with `encrypt: "required"` (a value not in the supported enum)
- **THEN** the MS SQL Server module returns `AppError::Validation` with a message naming the supported values (`off`, `on`, `strict`)

#### Scenario: read_only defaults to false

- **WHEN** the user submits MS SQL Server params without an explicit `read_only` field
- **THEN** the persisted row has `read_only: false`

#### Scenario: trust_server_certificate defaults to false

- **WHEN** the user submits MS SQL Server params without an explicit `trust_server_certificate` field
- **THEN** the persisted row has `trust_server_certificate: false`

#### Scenario: Optional instance_name accepted

- **WHEN** the user submits MS SQL Server params with `instance_name: "SQLEXPRESS"`
- **THEN** the value is persisted alongside the rest of the params and round-trips through `connections.list`

### Requirement: MS SQL Server connection URL parsing

The MS SQL Server module SHALL expose a pure function `parseMssqlUrl(input: string)` that accepts three input shapes and returns `{ params: MssqlParams, password?: string }`:

1. A `mssql://user:password@host:port/database?...` URL — the canonical form.
2. A `sqlserver://user:password@host:port/database?...` URL — alias for `mssql://`. The `jdbc:sqlserver://` prefix SHALL be accepted by stripping the leading `jdbc:` before parsing.
3. An ADO.NET key=value connection string such as `Server=tcp:host,1433;Database=MyDb;User Id=sa;Password=Pass!;Encrypt=True;TrustServerCertificate=False;`. Keys MUST be matched case-insensitively and the documented synonyms MUST be accepted: `Server` == `Data Source` == `Addr` == `Address` == `Network Address`; `Database` == `Initial Catalog`; `User Id` == `Uid` == `User`; `Password` == `Pwd`.

The function MUST URL-decode user info on URL forms, default the port to `1433` when absent, and map the `encrypt` (or `Encrypt`) parameter to the typed `EncryptMode` enum. It MUST map the `trust_server_certificate` (or `TrustServerCertificate`) parameter to a boolean. It MUST map the `application_intent` (or `ApplicationIntent`) parameter to the `application_intent` field. Vendor-specific extras (e.g. `statusColor`, `tLSMode`, `driverVersion` from TablePlus / Azure Data Studio exports) MUST be ignored with a warning rather than rejected. The function MUST return a typed error for malformed inputs or unknown `encrypt` values.

#### Scenario: Full mssql:// URL parses

- **WHEN** the user pastes `mssql://sa:s3cret@db.local:1433/Analytics?encrypt=on&trust_server_certificate=false`
- **THEN** `parseMssqlUrl` returns params `{ host: "db.local", port: 1433, database: "Analytics", username: "sa", encrypt: "on", trust_server_certificate: false, read_only: false }` and `password: "s3cret"`

#### Scenario: sqlserver:// scheme parses

- **WHEN** the user pastes `sqlserver://sa@db.local:1433/Analytics?encrypt=strict`
- **THEN** `parseMssqlUrl` returns params `{ host: "db.local", port: 1433, database: "Analytics", username: "sa", encrypt: "strict", trust_server_certificate: false, read_only: false }`

#### Scenario: jdbc:sqlserver:// prefix is stripped

- **WHEN** the user pastes `jdbc:sqlserver://db.local:1433;databaseName=Analytics;user=sa;password=s3cret`
- **THEN** `parseMssqlUrl` strips the `jdbc:` prefix, recognizes the remaining JDBC-style key=value tail, and returns `host: "db.local"`, `port: 1433`, `database: "Analytics"`, `username: "sa"`, and `password: "s3cret"`

#### Scenario: ADO.NET connection string parses

- **WHEN** the user pastes `Server=tcp:db.local,1433;Database=Analytics;User Id=sa;Password=Pass!;Encrypt=True;TrustServerCertificate=False;`
- **THEN** `parseMssqlUrl` returns params `{ host: "db.local", port: 1433, database: "Analytics", username: "sa", encrypt: "on", trust_server_certificate: false, read_only: false }` and `password: "Pass!"`

#### Scenario: ADO.NET synonyms are accepted

- **WHEN** the user pastes `Data Source=db.local;Initial Catalog=Analytics;Uid=sa;Pwd=Pass!;`
- **THEN** `parseMssqlUrl` recognizes `Data Source` as host, `Initial Catalog` as database, `Uid` as username, and `Pwd` as password, with defaults for the missing fields

#### Scenario: ADO.NET keys are case-insensitive

- **WHEN** the user pastes `SERVER=db.local;database=Analytics;user id=sa;PASSWORD=Pass!;encrypt=true;`
- **THEN** `parseMssqlUrl` matches each key case-insensitively and returns the same params as the canonically-cased form

#### Scenario: Missing port defaults to 1433

- **WHEN** the user pastes `mssql://sa@db.local/Analytics`
- **THEN** the returned params have `port: 1433`

#### Scenario: URL-encoded credentials are decoded

- **WHEN** the user pastes `mssql://us%40r:p%2Fss@db.local/Analytics`
- **THEN** the returned `username` is `us@r` and the returned `password` is `p/ss`

#### Scenario: ApplicationIntent parameter parsed

- **WHEN** the user pastes `mssql://sa@db.local/Analytics?application_intent=read-only`
- **THEN** the returned params have `application_intent: "read-only"`

#### Scenario: Vendor extras ignored with warning

- **WHEN** the user pastes `mssql://sa@db.local/Analytics?encrypt=on&statusColor=blue&driverVersion=9.0`
- **THEN** `parseMssqlUrl` returns valid params with `encrypt: "on"` and the unrecognized `statusColor` / `driverVersion` keys are dropped (warning logged but not surfaced as error)

#### Scenario: Malformed URL rejected

- **WHEN** the user pastes a string that is not a valid URL or ADO.NET connection string (for example `not-a-url-or-conn`)
- **THEN** `parseMssqlUrl` returns a typed error and the form shows a clear message

#### Scenario: Unknown encrypt mode in URL rejected

- **WHEN** the user pastes a URL with `?encrypt=preferred`
- **THEN** `parseMssqlUrl` returns a typed error naming the supported `encrypt` values (`off`, `on`, `strict`)

### Requirement: Test connection command

The MS SQL Server module SHALL expose a Tauri command `mssql.testConnection(params, secret?)` that opens a single TDS connection (no pool), runs `SELECT @@VERSION`, closes it, and returns either `{ ok: true, latencyMs: number, serverVersion: string }` or `{ ok: false, error: AppError }`. The command MUST honor `encrypt` and `trust_server_certificate` for TLS behavior, MUST timeout after 8 seconds total, and MUST NOT persist anything. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "test_connection"`, `connection_id: null`, `origin: "user"`, `duration_ms` measuring the wall time spent in the command, `sql: null`, `params: null`, `metric: { kind: "server_version", value: serverVersion }` on success or `null` on failure, and `status` matching the result.

#### Scenario: Successful test against a reachable SQL Server

- **WHEN** the user fills the form for a reachable SQL Server instance and clicks "Test"
- **THEN** the command returns `{ ok: true, latencyMs: <measured>, serverVersion: "Microsoft SQL Server 2022 ..." }` within the timeout

#### Scenario: Successful test against Azure SQL Database

- **WHEN** the user fills the form for a reachable Azure SQL Database with `encrypt: "on"` and clicks "Test"
- **THEN** the command returns `{ ok: true, latencyMs: <measured>, serverVersion: "Microsoft SQL Azure ..." }` within the timeout

#### Scenario: Wrong password reported as MS SQL Server error 18456

- **WHEN** the user tests a connection whose password is incorrect
- **THEN** the command returns `{ ok: false, error: AppError::Mssql }` with `code: 18456` preserved in the error code (login failed)

#### Scenario: Cannot open database reported as MS SQL Server error 4060

- **WHEN** the user tests a connection whose login is valid but the named database does not exist or is inaccessible to that login
- **THEN** the command returns `{ ok: false, error: AppError::Mssql }` with `code: 4060`

#### Scenario: Unreachable host reported as MS SQL Server error without code

- **WHEN** the user tests a connection whose host does not resolve
- **THEN** the command returns `{ ok: false, error: AppError::Mssql }` with `code: null` and a message indicating DNS or connect failure

#### Scenario: Connection refused reported without code

- **WHEN** the user tests a connection whose host resolves but TCP connect is refused
- **THEN** the command returns `{ ok: false, error: AppError::Mssql }` with `code: null` and a message describing the connect failure

#### Scenario: TLS handshake failure reported without code

- **WHEN** the user tests a connection with `encrypt: "on"` and `trust_server_certificate: false` against a server with an untrusted certificate
- **THEN** the command returns `{ ok: false, error: AppError::Mssql }` with `code: null` and a message describing the TLS verification failure

#### Scenario: Timeout after 8 seconds

- **WHEN** the test takes longer than 8 seconds (network silently drops packets)
- **THEN** the command returns `{ ok: false, error: AppError::Mssql }` with a timeout message

#### Scenario: Test does not persist anything

- **WHEN** the user runs `mssql.testConnection` for a not-yet-saved form
- **AND** the user subsequently calls `connections.list`
- **THEN** the list does not contain a record for the tested params

#### Scenario: Successful test emits an activity-log entry

- **WHEN** the user runs `mssql.testConnection` and it succeeds
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "test_connection"`, `status: "ok"`, `metric: { kind: "server_version", value: <returned serverVersion> }`, `connection_id: null`

#### Scenario: Failing test emits an activity-log entry with error

- **WHEN** the user runs `mssql.testConnection` and the server rejects the password
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "test_connection"`, `status: "err"`, `error.code: 18456`, `metric: null`

### Requirement: Connect command and pool registry

The MS SQL Server module SHALL expose a Tauri command `mssql.connect(connectionId)` that loads the params and secret for the given id, builds a `bb8::Pool<bb8_tiberius::ConnectionManager>` with min=1, max=4, eagerly fetches one connection to verify the handshake (running `SELECT @@VERSION`), and registers the pool in a backend `MssqlPoolRegistry` keyed by connection id. If a pool already exists for the id, the existing pool MUST be returned without rebuilding. On success the command returns `{ serverVersion: string, readOnly: boolean }`. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "connect"`, `connection_id: <id>`, `origin: "user"`, `sql: null`, `params: null`, `metric: { kind: "server_version", value: serverVersion }` on success (`null` on failure), `status` matching the result, and `duration_ms` covering the entire command.

#### Scenario: Connect succeeds and exposes server version

- **WHEN** the user invokes `mssql.connect(id)` for a valid MS SQL Server connection
- **THEN** the command returns `{ serverVersion: "Microsoft SQL Server 2022 ...", readOnly: false }` and the pool is now registered under `id`

#### Scenario: Idempotent connect

- **WHEN** the user invokes `mssql.connect(id)` for an id that already has a registered pool
- **THEN** the command returns the same `{ serverVersion, readOnly }` without rebuilding the pool

#### Scenario: Connect with handshake failure returns AppError

- **WHEN** the user invokes `mssql.connect(id)` and the handshake fails (auth, TLS, network)
- **THEN** the command returns `AppError::Mssql` and no pool is registered under `id`

#### Scenario: Connect for unknown id

- **WHEN** the user invokes `mssql.connect(id)` for an id not present in the connections table
- **THEN** the command returns `AppError::NotFound` and no pool is registered

#### Scenario: Connect with read_only and Azure replica routes ApplicationIntent

- **WHEN** the user invokes `mssql.connect(id)` for a connection with `read_only: true` against an Azure SQL endpoint that exposes a read-only replica
- **THEN** the pool is built with `ApplicationIntent=ReadOnly` on the underlying `tiberius::Config` so the gateway routes traffic to the read-only replica

#### Scenario: Successful connect emits an activity-log entry

- **WHEN** `mssql.connect(id)` succeeds
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "connect"`, `status: "ok"`, `connection_id: <id>`, `origin: "user"`, `metric: { kind: "server_version", value: <returned serverVersion> }`

#### Scenario: Failing connect emits an activity-log entry with error

- **WHEN** `mssql.connect(id)` fails because the host is unreachable
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "connect"`, `status: "err"`, `connection_id: <id>`, `metric: null`, `error.message` describing the failure

### Requirement: Disconnect command

The MS SQL Server module SHALL expose a Tauri command `mssql.disconnect(connectionId)` that removes the pool registered under the given id from the registry. Idle connections in the pool MUST be closed; in-flight queries MUST be allowed to complete. Disconnecting an id that has no registered pool MUST return success silently. The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "disconnect"`, `connection_id: <id>`, `origin: "user"`, `sql: null`, `params: null`, `metric: null`, `status: "ok"`, and `duration_ms` covering the command.

#### Scenario: Disconnecting an active connection

- **WHEN** the user invokes `mssql.disconnect(id)` for an id that has a registered pool
- **THEN** the pool is removed from the registry and `mssql.listActive` no longer includes the id

#### Scenario: Disconnect when not connected is a no-op

- **WHEN** the user invokes `mssql.disconnect(id)` for an id that has no registered pool
- **THEN** the command returns success without error

#### Scenario: Disconnect emits an activity-log entry

- **WHEN** the user invokes `mssql.disconnect(id)`
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "disconnect"`, `status: "ok"`, `connection_id: <id>`, `origin: "user"`

### Requirement: Active connections enumeration and event

The MS SQL Server module SHALL expose a Tauri command `mssql.listActive()` that returns the currently registered pools as `Array<{ id: UUID, serverVersion: string, readOnly: boolean, connectedAt: ISO8601 }>`. After every successful `connect` or `disconnect`, the module SHALL emit a Tauri event `mssql:active-changed` with no payload, allowing the frontend to refresh.

#### Scenario: List active is empty initially

- **WHEN** no connections have been opened in the current app session
- **THEN** `mssql.listActive` returns `[]`

#### Scenario: Connect emits active-changed

- **WHEN** the user invokes `mssql.connect(id)` and it succeeds
- **THEN** the event `mssql:active-changed` is emitted exactly once

#### Scenario: Disconnect emits active-changed

- **WHEN** the user invokes `mssql.disconnect(id)` for a registered pool
- **THEN** the event `mssql:active-changed` is emitted exactly once

### Requirement: Read-only enforcement at the module boundary

When a connection's `params.read_only` is `true`, the MS SQL Server module SHALL enforce read-only semantics at the registry boundary BEFORE any mutating SQL is dispatched to the wire. For connections to Azure SQL Database / Managed Instance endpoints, the connection MUST additionally be configured with `ApplicationIntent=ReadOnly` so the gateway routes the connection to a read-only replica when one is available. The MS SQL Server module SHALL provide two execution helpers — `executeQuery` (always allowed) and `executeMutation` (rejected at the Rust boundary if the pool is read-only) — and MUST NOT expose a generic raw-pool accessor that bypasses these helpers.

`executeMutation(connection_id, sql, params)` MUST be implemented as a real, callable helper (not a stub or contract-only). It MUST:

1. Look up the pool for `connection_id` in `MssqlPoolRegistry`. Return `AppError::NotFound` if absent.
2. Check the pool's `read_only` flag BEFORE acquiring a session. If `true`, return `AppError::Validation { message: "connection is read-only" }` without dispatching any statement to the wire.
3. Acquire a session from the pool, execute the statement with bound `@P1, @P2, ...` parameters, and return the affected-row count.
4. Honor the same 15s timeout + cancel-token pattern used by `executeQuery`.

Higher-level commands that need transactional control (e.g. `mssql_apply_table_edits`) MAY acquire a session directly from the pool to manage the transaction lifetime explicitly — but MUST first perform the same `read_only` check that `executeMutation` performs.

#### Scenario: Mutation rejected before reaching the wire

- **WHEN** any module calls `executeMutation(id, "UPDATE t SET x = 1", [])` for a connection with `read_only: true`
- **THEN** the helper returns `AppError::Validation` with message `"connection is read-only"` and no SQL is sent to the server

#### Scenario: Mutation executes on writable connection

- **WHEN** any module calls `executeMutation(id, "UPDATE t SET x = @P1 WHERE id = @P2", ["a", 1])` for a writable connection
- **THEN** the statement is dispatched, the bound parameters are used, and the helper returns the affected-row count

#### Scenario: Read query allowed on read-only connection

- **WHEN** any module calls `executeQuery(id, "SELECT 1", [])` for a connection with `read_only: true`
- **THEN** the query executes successfully

#### Scenario: Server-side read-only replica rejects writes

- **WHEN** a mutating statement slips through to an Azure SQL connection routed to a read-only replica via `ApplicationIntent=ReadOnly`
- **THEN** the server rejects it with error 3906 or 3908 and the error surfaces as `AppError::Mssql` with that numeric code

#### Scenario: Transactional caller skips executeMutation but still checks read-only

- **WHEN** `mssql_apply_table_edits` runs against a connection with `read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }` BEFORE any `BEGIN TRAN` is dispatched

### Requirement: Error code mapping

The MS SQL Server module SHALL surface server errors as `AppError::Mssql { code: Option<i32>, message: String, line: Option<u32>, procedure: Option<String> }`, where `code` carries the numeric SQL Server error number returned by the server when available. Network, DNS, and TLS failures that occur before any error number is exchanged MUST set `code: None`. Query cancellation (driver-side `Cancelled` from TDS Attention) MUST be surfaced with `code: None` and a message of `"query cancelled"`. The following numeric codes MUST be preserved verbatim when the server returns them:

| Scenario | SQL Server code |
|---|---|
| Login failed (wrong password / user) | 18456 |
| Cannot open database | 4060 |
| Syntax error | 102, 103, 105, 156, 170, 174 |
| Invalid object name | 208 |
| Invalid column name | 207 |
| Constraint violation generic | 547 |
| Unique-key violation | 2627 |
| Duplicate key | 2601 |
| NOT NULL violation | 515 |
| String / binary truncation | 2628, 8152 |
| Numeric out of range | 8115 |
| Invalid date / time | 241, 242 |
| Read-only database / replica | 3906, 3908 |
| Lock wait timeout | 1222 |
| Deadlock victim | 1205 |

The `line` field MUST carry the 1-based line within the user-submitted batch when the server reports one. The `procedure` field MUST carry the procedure / trigger name when the server reports one (otherwise null).

#### Scenario: Login failed surfaces 18456

- **WHEN** a command receives a SQL Server login-failed error from the server
- **THEN** the resulting `AppError::Mssql` has `code: 18456` and a message that does not embed the password

#### Scenario: Cannot open database surfaces 4060

- **WHEN** the login is valid but the requested database does not exist or is inaccessible
- **THEN** the resulting `AppError::Mssql` has `code: 4060`

#### Scenario: Cancelled query surfaces None code

- **WHEN** a long-running query is cancelled via TDS Attention (or `KILL <spid>` fallback)
- **THEN** the resulting `AppError::Mssql` has `code: None` and message `"query cancelled"`

#### Scenario: Unique-key violation surfaces 2627

- **WHEN** an INSERT or UPDATE violates a unique constraint
- **THEN** the resulting `AppError::Mssql` has `code: 2627`

#### Scenario: Deadlock victim surfaces 1205

- **WHEN** the server picks the current session as a deadlock victim
- **THEN** the resulting `AppError::Mssql` has `code: 1205`

#### Scenario: TCP connect refused surfaces None code

- **WHEN** the server's host resolves but no process is listening on the port
- **THEN** the resulting `AppError::Mssql` has `code: None` and a message describing the connect failure

#### Scenario: DNS failure surfaces None code

- **WHEN** the server's host does not resolve
- **THEN** the resulting `AppError::Mssql` has `code: None`

#### Scenario: Server error reports line and procedure

- **WHEN** the server returns an error originating inside stored procedure `dbo.usp_foo` at line 12
- **THEN** the resulting `AppError::Mssql` has `line: Some(12)` and `procedure: Some("dbo.usp_foo")`

### Requirement: TLS modes and trust roots

The MS SQL Server module SHALL negotiate TLS via `tiberius`'s `rustls` feature backed by the bundled Mozilla root certificates (via the `webpki-roots` crate already used by Postgres). The `encrypt` enum SHALL drive TLS behavior as follows, combined with the boolean `trust_server_certificate`:

- `encrypt: "off"` MUST disable TLS entirely; the server may reject the connection if it requires encryption, and that rejection MUST surface verbatim.
- `encrypt: "on"` MUST negotiate TLS for the entire post-login session (the modern default, equivalent to `.NET` `Encrypt=true`).
- `encrypt: "strict"` MUST send the TLS ClientHello FIRST, before any TDS prelogin (TDS 8.0 strict encryption). This mode is required by Azure SQL when the strict-encryption posture is enforced.
- `trust_server_certificate: false` (the default) MUST verify the server certificate against the bundled Mozilla CA roots AND verify the certificate's subject matches the connection host.
- `trust_server_certificate: true` MUST require TLS but perform no certificate verification (encryption-only mode; required for local Docker SQL Server images that ship a self-signed certificate).

#### Scenario: Off mode connects without TLS

- **WHEN** a connection is opened with `encrypt: "off"`
- **THEN** the wire protocol is plain text and no TLS handshake is performed

#### Scenario: On mode with trust_server_certificate=false verifies chain and hostname

- **WHEN** a connection is opened with `encrypt: "on"` and `trust_server_certificate: false` to a server presenting a certificate signed by a trusted public CA whose subject matches the host
- **THEN** the handshake succeeds and the session is encrypted

#### Scenario: On mode rejects untrusted certificate

- **WHEN** a connection is opened with `encrypt: "on"` and `trust_server_certificate: false` against a server whose certificate is not signed by a bundled root
- **THEN** the handshake fails with `AppError::Mssql` carrying `code: None` and a TLS-verification message

#### Scenario: On mode rejects hostname mismatch

- **WHEN** a connection is opened with `encrypt: "on"` and `trust_server_certificate: false` to host `db.local` against a server whose certificate's subject is `other.local` (but is signed by a bundled root)
- **THEN** the handshake fails with `AppError::Mssql` carrying `code: None` and a hostname-verification message

#### Scenario: On mode with trust_server_certificate=true skips verification

- **WHEN** a connection is opened with `encrypt: "on"` and `trust_server_certificate: true` against a server presenting a self-signed certificate
- **THEN** the handshake succeeds and the session is encrypted

#### Scenario: Strict mode sends TLS first

- **WHEN** a connection is opened with `encrypt: "strict"` and `trust_server_certificate: false` against an Azure SQL endpoint with strict encryption enforced
- **THEN** the client sends the TLS ClientHello before any TDS prelogin packet and the handshake succeeds when the certificate is trusted

### Requirement: Connection form

The frontend SHALL provide a MS SQL Server connection form, opened from the sidebar "+" button and from the `Connection: New MS SQL Server…` palette command. The form MUST present two views switchable by a tab control: a "Form" view with fields `name`, `host`, `port` (defaulting to `1433`), `database`, `username`, `password`, `encrypt`, `trust_server_certificate`, `read_only`; and a "URL" view with a single text input plus a "Parse" button that accepts any of the three input shapes documented for `parseMssqlUrl` and fills the form fields then switches to the form view. The form MUST expose a "Test" button that invokes `mssql.testConnection` and shows the typed result inline, and "Save" / "Save & Connect" buttons that persist via `connections.create` (or `connections.update` in edit mode).

The authentication method MUST be clearly labeled "SQL Authentication" in the form. The form MUST NOT present a "Use Windows Authentication" toggle or any Azure AD / Managed Identity option in v1.

#### Scenario: Filling and saving a connection

- **WHEN** the user opens the form, fills valid fields, clicks "Save"
- **THEN** a row is created via `connections.create`, the dialog closes, and the connection appears in the sidebar

#### Scenario: Port defaults to 1433

- **WHEN** the user opens the form without prefilled values
- **THEN** the port field is prefilled with `1433`

#### Scenario: Auth method label reads "SQL Authentication"

- **WHEN** the user opens the form
- **THEN** the authentication section is clearly labeled "SQL Authentication" and no Windows / AAD / Managed Identity toggle is present

#### Scenario: Pasting a mssql:// URL fills the form

- **WHEN** the user pastes a `mssql://` URL in the URL view and clicks "Parse"
- **THEN** the form view becomes active with all parsed fields prefilled, and the password field contains the decoded password from the URL

#### Scenario: Pasting a sqlserver:// URL fills the form

- **WHEN** the user pastes a `sqlserver://` URL in the URL view and clicks "Parse"
- **THEN** the form view becomes active with all parsed fields prefilled

#### Scenario: Pasting a jdbc:sqlserver:// URL fills the form

- **WHEN** the user pastes a `jdbc:sqlserver://` URL in the URL view and clicks "Parse"
- **THEN** the form view becomes active with all parsed fields prefilled

#### Scenario: Pasting an ADO.NET connection string fills the form

- **WHEN** the user pastes `Server=tcp:db.local,1433;Database=Analytics;User Id=sa;Password=Pass!;Encrypt=True;` in the URL view and clicks "Parse"
- **THEN** the form view becomes active with `host: "db.local"`, `port: 1433`, `database: "Analytics"`, `username: "sa"`, password `"Pass!"`, and `encrypt: "on"` prefilled

#### Scenario: Test result shown inline

- **WHEN** the user clicks "Test" with valid form fields
- **THEN** the form shows either a green success row with `serverVersion` and `latencyMs`, or a red error row with the `AppError` message

#### Scenario: Save & Connect

- **WHEN** the user clicks "Save & Connect" with valid form fields
- **THEN** the connection is persisted, the dialog closes, `mssql.connect(id)` is invoked, and the sidebar reflects the connection as active

#### Scenario: Editing leaves the password unchanged when blank

- **WHEN** the user opens the form in edit mode, modifies `name`, leaves the password field empty, and clicks "Save"
- **THEN** `connections.update` is called with no `secret` field, the keychain entry is untouched, and the row is updated

### Requirement: Sidebar MS SQL Server connection rows

The sidebar's "Connections" section SHALL render each MS SQL Server connection as a row containing a `MssqlIcon`, the connection name, a status indicator (green dot when `useActiveConnections()` reports the id as connected, neutral dot when inactive, spinner while a connect call is in flight), and an "RO" badge when `params.read_only` is true.

The row's primary click handler SHALL behave as follows: on an inactive row it initiates `mssql.connect`; on a row whose connection is in flight (`mssql.connect` not yet resolved) it is a no-op; on an active row it performs no destructive action (no-op or non-destructive subtree affordance). The row click MUST NOT dispatch `mssql.disconnect`.

Disconnect MUST be reachable only from a dedicated `⏻` (power) button rendered on every active row, always visible (not hover-only) and sized to be a deliberate target distinct from the row body, or from the row's right-click context menu's `Disconnect` entry, or from the section-level "Disconnect all" affordance.

Right-clicking a row opens a context menu. On an active row the menu includes `New SQL Query`, `Disconnect`, then a separator, then `Edit`, `Duplicate`, and `Delete`. On an inactive row the menu includes only `Edit`, `Duplicate`, and `Delete`.

#### Scenario: Click on an inactive row connects

- **WHEN** the user clicks an inactive MS SQL Server connection row
- **THEN** `mssql.connect(id)` is invoked; on success the active indicator turns green

#### Scenario: Click on an active row does not disconnect

- **WHEN** the user clicks the body of a MS SQL Server connection row whose connection is currently active
- **THEN** no `mssql.disconnect` command is dispatched and the active state of the connection is unchanged

#### Scenario: Click on a connecting row does not disconnect or re-connect

- **WHEN** the user clicks the body of a MS SQL Server connection row while `mssql.connect` for that row is still pending
- **THEN** no additional `mssql.connect` or `mssql.disconnect` is dispatched until the in-flight call resolves

#### Scenario: Disconnect button is always visible on active rows

- **WHEN** any MS SQL Server connection is active in the sidebar
- **THEN** that row renders a `⏻` button regardless of hover state, with a `title`/`aria-label` of "Disconnect"

#### Scenario: Disconnect button is hidden on inactive rows

- **WHEN** a MS SQL Server connection is not active
- **THEN** the row does not render a `⏻` button

#### Scenario: RO badge visible when read-only

- **WHEN** a MS SQL Server connection has `params.read_only: true`
- **THEN** the row displays an "RO" badge next to the name

#### Scenario: Right-click context menu on active row

- **WHEN** the user right-clicks an active MS SQL Server connection row
- **THEN** a menu appears with `New SQL Query`, `Disconnect`, `Edit`, `Duplicate`, and `Delete`; choosing `Edit` opens the form prefilled with the connection's params and an empty password field

#### Scenario: Right-click context menu on inactive row

- **WHEN** the user right-clicks an inactive MS SQL Server connection row
- **THEN** a menu appears with `Edit`, `Duplicate`, and `Delete`

#### Scenario: Delete confirmation

- **WHEN** the user chooses `Delete` from the context menu and confirms
- **THEN** `connections.delete(id)` is invoked, the row disappears, and any active pool for that id is dropped via `mssql.disconnect`

### Requirement: Disconnect requires a confirmation step

Activating the per-row `⏻` Disconnect button SHALL open a confirmation dialog before any `mssql.disconnect` is dispatched. The dialog MUST always be shown (it MUST NOT be skipped when there is no apparent state at risk). The dialog body MUST adapt to what is open for that connection at the moment the dialog opens:

- A "Disconnect `<name>`?" heading line is always present.
- When one or more tabs belong to that connection, a "N tab(s) will close." line is shown with the exact count.
- When one or more dirty edit buffers belong to that connection, a strong-warning line "M unsaved edit(s) will be discarded:" is shown followed by the list of affected `<table>` names. The strong-warning line MUST be visually distinct from the tab-count line.

The dialog footer MUST present a non-destructive Cancel action and a destructive-styled Disconnect action. Cancel MUST close the dialog without dispatching any command. Disconnect MUST dispatch `mssql.disconnect(connectionId)` and close the dialog.

The dialog MUST source the dirty-buffer summary from the same registry that gates per-tab close confirmation; a tab whose close confirmation reports clean MUST NOT contribute a "unsaved edit" line.

#### Scenario: Confirm shows even with nothing at risk

- **WHEN** the user clicks `⏻` on an active MS SQL Server connection that has zero open tabs and zero dirty buffers
- **THEN** the confirmation dialog opens with only the heading line and a [Cancel] [Disconnect] footer
- **AND** no `mssql.disconnect` is dispatched until Disconnect is clicked

#### Scenario: Confirm lists tab count when tabs are open

- **WHEN** the user clicks `⏻` on a MS SQL Server connection that has 3 open tabs and zero dirty buffers
- **THEN** the dialog body includes a line stating "3 tabs will close."

#### Scenario: Confirm warns and names tables when buffers are dirty

- **WHEN** the user clicks `⏻` on a MS SQL Server connection that has 2 open tabs, of which 1 has a dirty edit buffer for the `dbo.Users` table
- **THEN** the dialog body includes "2 tabs will close." and a separate strong-warning line "1 unsaved edit will be discarded:" followed by `dbo.Users`

#### Scenario: Cancel does not disconnect

- **WHEN** the confirmation dialog is open and the user clicks Cancel
- **THEN** no `mssql.disconnect` is dispatched and the dialog closes

#### Scenario: Disconnect proceeds and closes the dialog

- **WHEN** the confirmation dialog is open and the user clicks Disconnect
- **THEN** `mssql.disconnect(connectionId)` is dispatched exactly once and the dialog closes

### Requirement: Connecting visual state ignores further clicks

While `mssql.connect` is in flight for a given connection row, the row SHALL display a busy indicator in place of the active dot (a spinner or equivalent) and its primary click handler MUST be a no-op. The busy state begins when `mssql.connect` is dispatched and ends when the promise resolves or rejects.

#### Scenario: Connecting row shows a busy indicator

- **WHEN** the user clicks an inactive MS SQL Server connection row and `mssql.connect` is dispatched
- **THEN** until the call resolves, the row's active dot is replaced with a busy indicator

#### Scenario: Click during connecting is a no-op

- **WHEN** the user clicks the body of a row that is in the connecting state
- **THEN** no additional `mssql.connect` or `mssql.disconnect` is dispatched

### Requirement: Disconnect-all command and trigger

The sidebar Connections section header SHALL render a "Disconnect all" affordance that is visible only when at least one connection is active. Activating it MUST open the same confirmation dialog defined for per-row disconnect, with the body aggregating across every active connection: total connection count, total tab count across those connections, and a strong-warning line when any of those tabs has a dirty edit buffer (listing each affected `<connection>.<table>` pair).

The MS SQL Server module SHALL expose a Tauri command `mssql.disconnect_all()` that snapshots the set of currently active MS SQL Server pool ids under the registry's write lock, removes all of them, and returns the number of pools that were dropped. After the command completes the module SHALL emit exactly one `mssql:active-changed` event and exactly one `argus:activity-log` event with `kind: "disconnect"`, `connection_id: null`, `origin: "user"`, `status: "ok"`, `duration_ms` covering the whole command, `sql: null`, `params: null`, and a metric describing the count of dropped pools.

The frontend "Disconnect all" Disconnect action MUST dispatch `mssql.disconnect_all()` once rather than looping per-id `mssql.disconnect` calls (when scoped to MS SQL Server).

#### Scenario: Disconnect-all affordance hidden when no connection is active

- **WHEN** zero MS SQL Server connections are active
- **THEN** the Connections section header does not render a Disconnect-all affordance for MS SQL Server

#### Scenario: Disconnect-all affordance visible when one or more are active

- **WHEN** at least one MS SQL Server connection is active
- **THEN** the Connections section header renders a Disconnect-all affordance with a `title`/`aria-label` of "Disconnect all"

#### Scenario: Disconnect-all dialog aggregates counts

- **WHEN** the user activates Disconnect-all with 3 active MS SQL Server connections that together have 5 open tabs and 1 dirty buffer for `Analytics.dbo.Users`
- **THEN** the confirmation dialog shows the connection count, "5 tabs will close.", and a strong-warning line listing `Analytics.dbo.Users`

#### Scenario: Disconnect-all dispatches one command

- **WHEN** the user confirms the Disconnect-all dialog with 3 active MS SQL Server connections
- **THEN** exactly one `mssql.disconnect_all()` Tauri command is dispatched
- **AND** zero per-id `mssql.disconnect()` commands are dispatched as part of this gesture

#### Scenario: disconnect_all removes all pools

- **WHEN** the backend receives `mssql.disconnect_all()` with 3 registered pools
- **THEN** all 3 pools are removed from `MssqlPoolRegistry` and `mssql.list_active()` subsequently returns an empty list

#### Scenario: disconnect_all emits one active-changed event

- **WHEN** `mssql.disconnect_all()` completes successfully with N ≥ 1 pools dropped
- **THEN** exactly one `mssql:active-changed` event is emitted

#### Scenario: disconnect_all emits one activity-log entry

- **WHEN** `mssql.disconnect_all()` completes with N pools dropped
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "disconnect"`, `status: "ok"`, `connection_id: null`, and a metric whose value equals N

#### Scenario: disconnect_all with no active pools is a no-op

- **WHEN** `mssql.disconnect_all()` is invoked while `MssqlPoolRegistry` is empty
- **THEN** the command returns 0, no `mssql:active-changed` event is emitted, and no `argus:activity-log` event is emitted

### Requirement: Palette commands for MS SQL Server connections

The MS SQL Server module SHALL register the following commands in the `command-palette` registry on app start. `Connection: New MS SQL Server…` is MS SQL Server-specific and opens the MS SQL Server connection form. `Connection: Test…`, `Connection: Connect…`, and `Connection: Disconnect…` are shared, driver-agnostic palette commands registered by the platform; when invoked against a focused MS SQL Server row (or after the chooser selects a MS SQL Server connection) they MUST route to `mssql.testConnection`, `mssql.connect`, and `mssql.disconnect` respectively.

#### Scenario: New MS SQL Server command opens the form

- **WHEN** the user opens the palette and activates `Connection: New MS SQL Server…`
- **THEN** the MS SQL Server connection form opens in "Form" view with empty fields (port prefilled to `1433`)

#### Scenario: Test command without a selection shows a chooser

- **WHEN** the user activates `Connection: Test…` with no sidebar selection
- **THEN** the palette transitions to a chooser listing existing connections; selecting a MS SQL Server connection runs `mssql.testConnection`

#### Scenario: Connect command routes to mssql.connect for a focused MS SQL Server row

- **WHEN** the user focuses a MS SQL Server row in the sidebar and activates `Connection: Connect…`
- **THEN** `mssql.connect(id)` is dispatched for that row

#### Scenario: Disconnect command routes to mssql.disconnect for a focused MS SQL Server row

- **WHEN** the user focuses an active MS SQL Server row in the sidebar and activates `Connection: Disconnect…`
- **THEN** the disconnect-confirmation dialog opens and, on confirm, `mssql.disconnect(id)` is dispatched for that row

### Requirement: MS SQL Server icon visual identity

The `MssqlIcon` component exported from `src/modules/mssql/index.ts` SHALL render a stylized "server stack with a small flag/pennant" silhouette, designed so that at 14px (the sidebar connection-row size) it is unambiguously distinguishable from the `PostgresIcon` (elephant), `MysqlIcon` (dolphin), and `DynamoIcon` (stacked cylinders) silhouettes without color cues.

The icon MUST:
- Use a 24×24 viewBox.
- Use hairline strokes only (`stroke-width` 1.5, `stroke="currentColor"`, no `fill` other than `currentColor` on tiny detail nodes ≤1px radius).
- Inherit color via `currentColor`. The component MUST NOT hardcode any color value, gradient, brand color, or duotone fill.
- Expose the same component contract as the other driver icons: a named export `MssqlIcon` accepting `{ size?: number; className?: string }` with `size` defaulting to 16.
- Carry `role="img"` and `aria-label="MS SQL Server"` on the root `<svg>`.

The silhouette's primary shape category SHALL be "server-rack stack with a small flag/pennant rising from the top" — it MUST be visually distinct from the dolphin, elephant, and stacked-cylinder silhouettes used by the other driver icons. The icon MUST NOT use the trademarked Microsoft "running man" SQL Server logo.

#### Scenario: Sidebar shows the icon at 14px next to other driver rows

- **WHEN** the sidebar's Connections section renders a MS SQL Server row, a Postgres row, a MySQL row, and a DynamoDB row at the default 14px icon size
- **THEN** the MS SQL Server row's icon presents the server-stack-with-flag silhouette, distinct from the elephant, dolphin, and stacked-cylinder silhouettes, and a user can identify each row's kind by icon alone (no name, no badge) at normal reading distance

#### Scenario: Icon inherits muted text color

- **WHEN** `MssqlIcon` is rendered inside the sidebar where the parent applies `color: var(--text-muted)`
- **THEN** every stroked path and any tiny filled detail node in the SVG renders in the muted text color, with no hardcoded color string anywhere in the component

#### Scenario: Icon component contract is preserved

- **WHEN** a caller renders `<MssqlIcon />`, `<MssqlIcon size={14} />`, `<MssqlIcon size={20} />`, or `<MssqlIcon className="foo" />`
- **THEN** the SVG renders at the requested square size (defaulting to 16), applies the optional className to the root `<svg>`, and exposes `role="img"` with `aria-label="MS SQL Server"`

