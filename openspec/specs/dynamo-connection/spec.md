# dynamo-connection Specification

## Purpose
TBD - created by archiving change add-dynamo-connection. Update Purpose after archive.
## Requirements
### Requirement: DynamoDB connection params shape

The Dynamo module SHALL define and own a typed params shape: `{ auth: "access_keys" | "profile", profile?: string, region: string, endpoint_url?: string, read_only: boolean, needs_credentials?: boolean }`. When a connection is created or updated with `kind: "dynamodb"`, the Dynamo module MUST validate the params before persistence and reject invalid values with `AppError::Validation`. The platform's `connection-registry` continues to treat `params` as opaque JSON; only the Dynamo module reads it.

#### Scenario: Valid access-keys params round-trip

- **WHEN** the user creates a Dynamo connection with `auth: "access_keys"`, `region: "us-east-1"`, `read_only: false`
- **THEN** the connection is persisted via `connections.create` and `connections.list` returns the same params shape
- **AND** the keychain entry under `connection:<id>` holds JSON `{ access_key_id, secret_access_key, session_token? }`

#### Scenario: Valid profile params round-trip

- **WHEN** the user creates a Dynamo connection with `auth: "profile"`, `profile: "argus-readonly"`, `region: "eu-west-1"`, `read_only: true`
- **THEN** the connection is persisted via `connections.create`, `connections.list` returns the same params shape
- **AND** no keychain entry is written for that id

#### Scenario: Missing region rejected

- **WHEN** the user submits Dynamo params with `region: ""` or `region` omitted
- **THEN** the Dynamo module returns `AppError::Validation` and no row is created

#### Scenario: Region not in known list rejected

- **WHEN** the user submits Dynamo params with `region: "us-mars-1"` (not a known AWS region)
- **THEN** the Dynamo module returns `AppError::Validation` with a message naming the failed field

#### Scenario: Access keys mode requires keys

- **WHEN** the user submits Dynamo params with `auth: "access_keys"` and the secret is missing or has empty `access_key_id`
- **THEN** the Dynamo module returns `AppError::Validation` and no row or keychain entry is created

#### Scenario: Profile mode requires profile name

- **WHEN** the user submits Dynamo params with `auth: "profile"` and `profile` omitted or empty
- **THEN** the Dynamo module returns `AppError::Validation` and no row is created

#### Scenario: Endpoint URL must be well-formed

- **WHEN** the user submits Dynamo params with `endpoint_url: "not a url"`
- **THEN** the Dynamo module returns `AppError::Validation` referencing the endpoint field

#### Scenario: read_only defaults to false

- **WHEN** the user submits Dynamo params without an explicit `read_only` field
- **THEN** the persisted row has `read_only: false`

#### Scenario: needs_credentials is internal

- **WHEN** a caller submits `connections.create` or `connections.update` with `needs_credentials: true` from the frontend
- **THEN** the Dynamo module strips that field before persistence so it can only be set internally by the expiration-detection flow

### Requirement: List AWS profiles command

The Dynamo module SHALL expose a Tauri command `dynamo.listAwsProfiles()` that reads `~/.aws/credentials` and `~/.aws/config` at call time and returns `Array<{ name: string, sso: boolean, region?: string }>`. A profile MUST be reported with `sso: true` when its config section contains any of `sso_session`, `sso_start_url`, or `sso_account_id`. Profile resolution MUST NOT follow `source_profile` chains in this capability.

#### Scenario: No AWS config files

- **WHEN** neither `~/.aws/credentials` nor `~/.aws/config` exists
- **THEN** the command returns `[]`

#### Scenario: Plain access-keys profile

- **WHEN** `~/.aws/credentials` contains a profile `[my-profile]` with `aws_access_key_id` and `aws_secret_access_key` and no SSO fields
- **THEN** the command's result includes `{ name: "my-profile", sso: false, region: undefined }`

#### Scenario: SSO profile

- **WHEN** `~/.aws/config` contains `[profile org-sso]` with `sso_start_url = https://example.awsapps.com/start`, `sso_region = us-east-1`, `region = us-east-2`
- **THEN** the command's result includes `{ name: "org-sso", sso: true, region: "us-east-2" }`

#### Scenario: Filesystem read happens every call

- **WHEN** the command is invoked, then the user edits `~/.aws/config` to add a new profile, then the command is invoked again
- **THEN** the second result includes the new profile without requiring an app restart

### Requirement: Test connection command

The Dynamo module SHALL expose a Tauri command `dynamo.testConnection(params, secret?)` that builds an AWS STS client using the same credential resolution path the Dynamo client would, calls `GetCallerIdentity`, measures wall-clock latency, and returns either `{ ok: true, latencyMs: number, accountId: string, identityArn: string, region: string }` or `{ ok: false, error: AppError }`. The command MUST timeout after 8 seconds total, MUST NOT persist anything, and MUST emit exactly one `argus:activity-log` event before returning with `kind: "test_connection"`, `connection_id: null`, `origin: "user"`, `duration_ms` measuring wall time, `sql: null`, `params: null`, `metric: { kind: "aws_identity", value: "<accountId>:<identityArn>" }` on success or `null` on failure, and `status` matching the result.

#### Scenario: Successful test with access keys

- **WHEN** the user fills the form with valid access keys for a real AWS account, picks a region, and clicks "Test"
- **THEN** the command returns `{ ok: true, latencyMs: <measured>, accountId: "<12-digit>", identityArn: "arn:aws:iam::...", region: "<chosen region>" }` within the timeout

#### Scenario: Successful test with profile

- **WHEN** the user picks an AWS profile that has valid resolvable credentials and clicks "Test"
- **THEN** the command returns `{ ok: true, latencyMs, accountId, identityArn, region }`
- **AND** no keychain access is attempted for that connection

#### Scenario: Expired session token

- **WHEN** the user tests an access-keys connection whose `session_token` has expired
- **THEN** the command returns `{ ok: false, error: AppError::Aws }` with `code` in `{ "ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId" }`

#### Scenario: Expired SSO session

- **WHEN** the user tests a profile-mode connection whose SSO cache has expired
- **THEN** the command returns `{ ok: false, error: AppError::Aws }` with a message that names the exact command `aws sso login --profile <name>`

#### Scenario: Unreachable endpoint

- **WHEN** the user tests a connection with `endpoint_url: "http://nope.invalid"` that does not resolve
- **THEN** the command returns `{ ok: false, error: AppError::Aws }` with a message indicating DNS or connect failure

#### Scenario: Test does not persist

- **WHEN** the user runs `dynamo.testConnection` for a not-yet-saved form
- **AND** the user subsequently calls `connections.list`
- **THEN** the list does not contain a record for the tested params

#### Scenario: Successful test emits activity-log

- **WHEN** `dynamo.testConnection` succeeds
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "test_connection"`, `status: "ok"`, `metric: { kind: "aws_identity", value: "<accountId>:<identityArn>" }`, `connection_id: null`

#### Scenario: Failing test emits activity-log

- **WHEN** `dynamo.testConnection` fails with expired credentials
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "test_connection"`, `status: "err"`, `metric: null`, `error.code: "ExpiredToken"` (or matching code)

### Requirement: Connect command and client registry

The Dynamo module SHALL expose a Tauri command `dynamo.connect(connectionId)` that loads the params and secret for the given id, resolves AWS credentials via either the keychain payload (access-keys mode) or the profile loader (profile mode), builds an `aws-sdk-dynamodb` client, performs an STS `GetCallerIdentity` handshake to verify the credentials work, and registers the resulting client in a backend `DynamoClientRegistry` keyed by connection id. If a client already exists for the id, the existing client MUST be returned without rebuilding. On success the command returns `{ accountId: string, identityArn: string, region: string, readOnly: boolean }`. The command SHALL emit exactly one `argus:activity-log` event before returning with `kind: "connect"`, `connection_id: <id>`, `origin: "user"`, `sql: null`, `params: null`, `metric: { kind: "aws_identity", value: "<accountId>:<identityArn>" }` on success (`null` on failure), `status` matching the result, and `duration_ms` covering the entire command.

#### Scenario: Connect succeeds

- **WHEN** the user invokes `dynamo.connect(id)` for a valid Dynamo connection
- **THEN** the command returns `{ accountId, identityArn, region, readOnly }` and the client is registered under `id`
- **AND** the event `dynamo:active-changed` is emitted exactly once

#### Scenario: Idempotent connect

- **WHEN** the user invokes `dynamo.connect(id)` for an id that already has a registered client
- **THEN** the command returns the same `{ accountId, identityArn, region, readOnly }` without rebuilding the client

#### Scenario: Handshake failure on expired access keys

- **WHEN** the user invokes `dynamo.connect(id)` and the handshake fails with an expired session token
- **THEN** the command returns `AppError::Aws` with the matching `ExpiredToken*` code
- **AND** no client is registered under `id`
- **AND** the connection's `needs_credentials` flag is set to `true` via `connections.update` issued from the backend

#### Scenario: Handshake failure on expired SSO

- **WHEN** the user invokes `dynamo.connect(id)` for a profile-mode connection whose SSO cache has expired
- **THEN** the command returns `AppError::Aws` whose message names `aws sso login --profile <name>`
- **AND** the connection's `needs_credentials` flag is NOT set (nothing the app can fix in keychain)

#### Scenario: Unknown id

- **WHEN** the user invokes `dynamo.connect(id)` for an id not present in the connections table
- **THEN** the command returns `AppError::NotFound`

#### Scenario: Successful connect emits activity-log

- **WHEN** `dynamo.connect(id)` succeeds
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "connect"`, `status: "ok"`, `connection_id: <id>`, `metric: { kind: "aws_identity", value: "<accountId>:<identityArn>" }`

### Requirement: Disconnect command

The Dynamo module SHALL expose a Tauri command `dynamo.disconnect(connectionId)` that removes the active client registered under the given id from `DynamoClientRegistry`. Disconnecting an id with no registered client MUST return success silently. The command SHALL emit exactly one `argus:activity-log` event before returning with `kind: "disconnect"`, `connection_id: <id>`, `origin: "user"`, `sql: null`, `params: null`, `metric: null`, `status: "ok"`, and `duration_ms` covering the command. After the command completes, the module SHALL emit `dynamo:active-changed` exactly once.

#### Scenario: Disconnecting an active client

- **WHEN** the user invokes `dynamo.disconnect(id)` for an id that has a registered client
- **THEN** the client is removed from the registry and `dynamo.listActive` no longer includes the id
- **AND** `dynamo:active-changed` is emitted exactly once

#### Scenario: Disconnect when not connected is a no-op

- **WHEN** the user invokes `dynamo.disconnect(id)` for an id that has no registered client
- **THEN** the command returns success without error and no `dynamo:active-changed` event is emitted

#### Scenario: Disconnect emits activity-log

- **WHEN** the user invokes `dynamo.disconnect(id)` for an active connection
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "disconnect"`, `status: "ok"`, `connection_id: <id>`, `origin: "user"`

### Requirement: Active connections enumeration and event

The Dynamo module SHALL expose a Tauri command `dynamo.listActive()` that returns the currently registered clients as `Array<{ id: UUID, accountId: string, identityArn: string, region: string, readOnly: boolean, connectedAt: ISO8601 }>`. After every successful `dynamo.connect` or `dynamo.disconnect`, the module SHALL emit a Tauri event `dynamo:active-changed` with no payload, allowing the frontend to refresh.

#### Scenario: List active is empty initially

- **WHEN** no Dynamo connections have been opened in the current app session
- **THEN** `dynamo.listActive` returns `[]`

#### Scenario: Connect emits active-changed

- **WHEN** the user invokes `dynamo.connect(id)` and it succeeds
- **THEN** the event `dynamo:active-changed` is emitted exactly once

#### Scenario: Disconnect emits active-changed

- **WHEN** the user invokes `dynamo.disconnect(id)` for a registered client
- **THEN** the event `dynamo:active-changed` is emitted exactly once

### Requirement: Update credentials command

The Dynamo module SHALL expose a Tauri command `dynamo.updateCredentials(connectionId, { aws_access_key_id, aws_secret_access_key, aws_session_token? })` that MUST be rejected with `AppError::Validation` for any connection whose `params.auth` is not `"access_keys"`. On success the command replaces the keychain entry under `connection:<id>` with the new payload, evicts any cached client registered for that id from `DynamoClientRegistry`, clears `params.needs_credentials` via the registry, and returns `{ ok: true }`. After the command completes successfully, the module SHALL emit a Tauri event `dynamo:credentials-refreshed` with payload `{ id: UUID }`.

#### Scenario: Update succeeds for access-keys connection

- **WHEN** the user submits new credentials for an access-keys connection that had `needs_credentials: true`
- **THEN** the keychain entry under `connection:<id>` is replaced
- **AND** any cached client for that id is evicted from `DynamoClientRegistry`
- **AND** the row's `params.needs_credentials` is `false`
- **AND** the event `dynamo:credentials-refreshed` is emitted with `{ id }`

#### Scenario: Update rejected for profile connection

- **WHEN** the user invokes `dynamo.updateCredentials` for a profile-mode connection
- **THEN** the command returns `AppError::Validation` and nothing in keychain or registry is changed

#### Scenario: Update for unknown id

- **WHEN** the user invokes `dynamo.updateCredentials` for an id that does not exist
- **THEN** the command returns `AppError::NotFound`

### Requirement: Read-only enforcement contract

The Dynamo module's active-client envelope SHALL carry a snapshot of `params.read_only` taken at connect time. The module SHALL expose an internal helper `require_writable(connection_id) -> AppResult<()>` that returns `AppError::Validation { message: "connection is read-only" }` when the snapshot is `true`, and `Ok(())` otherwise. Every mutating Dynamo command introduced by future changes MUST call `require_writable` before dispatching any request to the AWS API. The Dynamo module MUST NOT expose a raw client accessor that bypasses this contract.

#### Scenario: Helper rejects mutation on read-only client

- **WHEN** any caller invokes `require_writable(id)` for a connection whose active-client envelope has `read_only: true`
- **THEN** the helper returns `AppError::Validation` with message `"connection is read-only"`

#### Scenario: Helper allows mutation on writable client

- **WHEN** any caller invokes `require_writable(id)` for a connection with `read_only: false`
- **THEN** the helper returns `Ok(())`

#### Scenario: Helper rejects with NotFound for unknown id

- **WHEN** any caller invokes `require_writable(id)` for an id without a registered client
- **THEN** the helper returns `AppError::NotFound`

### Requirement: Credential expiration detection and re-prompt

When any Dynamo backend command (including `dynamo.connect` and any future command using the client registry) receives an AWS error whose code is one of `ExpiredToken`, `ExpiredTokenException`, or `InvalidClientTokenId` AND the connection's `params.auth` is `"access_keys"` AND a `session_token` is currently stored in keychain for that id, the module SHALL set `params.needs_credentials = true` on the connection via the registry, evict the cached client (if any) from `DynamoClientRegistry`, and surface a kind-specific error variant the frontend can detect. The frontend SHALL respond to that variant by opening the Dynamo connection form in "credentials only" sub-mode with `access_key_id` and `secret_access_key` pre-filled from keychain and `session_token` empty and focused, and by emitting a toast "Session token expired — re-enter credentials". Open tabs for the affected connection MUST remain mounted; tabs that depend on the client MAY display a "Reconnecting…" overlay until `dynamo:credentials-refreshed` fires for the id.

#### Scenario: Expired access-keys session token triggers needs_credentials

- **WHEN** a Dynamo command fails with `ExpiredToken` on a connection whose `params.auth = "access_keys"` and whose keychain payload includes `session_token`
- **THEN** `params.needs_credentials` becomes `true`
- **AND** the cached client (if any) is evicted from `DynamoClientRegistry`
- **AND** the frontend opens the connection form in "credentials only" sub-mode for that id

#### Scenario: Expired access-keys without session token does not trigger re-prompt

- **WHEN** a Dynamo command fails with `ExpiredToken` on a connection whose keychain payload has no `session_token`
- **THEN** the command returns `AppError::Aws` as-is
- **AND** `params.needs_credentials` is NOT modified

#### Scenario: SSO expiration does not trigger needs_credentials

- **WHEN** a Dynamo command fails with an SSO-expired error on a profile-mode connection
- **THEN** `params.needs_credentials` is NOT modified
- **AND** the error message names `aws sso login --profile <name>`

#### Scenario: Open tabs survive re-prompt

- **WHEN** a Dynamo connection enters `needs_credentials` while one or more tabs for that connection are open
- **THEN** no tabs are closed by the re-prompt flow

### Requirement: Dynamo connection form

The frontend SHALL provide a Dynamo connection form opened from the sidebar "+" kind picker (see `app-shell`) and from the `Connection: New DynamoDB…` palette command. The form MUST present:

1. A radio control selecting `Access Keys` or `AWS Profile` mode.
2. In `Access Keys` mode: inputs for `name`, `aws_access_key_id`, `aws_secret_access_key`, `aws_session_token` (optional), `region` (dropdown of known AWS regions), `endpoint_url` (optional), and a `read_only` toggle. A hint MUST be rendered: "If you paste a session token, your credentials are time-limited — Argus will re-ask when they expire."
3. In `AWS Profile` mode: inputs for `name`, `profile` (dropdown populated from `dynamo.listAwsProfiles()`), `region` (dropdown pre-filled from the profile's region when available but editable), `endpoint_url` (optional), and a `read_only` toggle. Each profile option whose `sso` flag is `true` MUST be rendered with an inline `SSO` badge and an auxiliary text "Requires `aws sso login --profile <name>` active in your terminal."

The form MUST expose a "Test" button that invokes `dynamo.testConnection` and shows the typed result inline (success row with `accountId`, `identityArn`, `latencyMs`; error row with `AppError` code and message; for SSO-expired errors a "Copy command" button next to the message). The form MUST expose "Save" and "Save & Connect" buttons that persist via `connections.create` (or `connections.update` in edit mode).

The form MUST support a "credentials only" sub-mode triggered by the re-prompt flow described in "Credential expiration detection and re-prompt". In that sub-mode, only the access-keys credential fields are editable; `region`, `endpoint_url`, `read_only`, `name`, and `auth` are read-only.

#### Scenario: Filling and saving an access-keys connection

- **WHEN** the user opens the form, picks Access Keys, fills valid fields, and clicks "Save"
- **THEN** a row is created via `connections.create` with `kind: "dynamodb"` and the params shape from the form, the keychain entry is written, the dialog closes, and the connection appears in the sidebar

#### Scenario: Filling and saving a profile connection

- **WHEN** the user opens the form, picks AWS Profile, selects `my-profile`, picks a region, and clicks "Save"
- **THEN** a row is created with `auth: "profile"`, `profile: "my-profile"`, and no keychain entry is written

#### Scenario: Profile dropdown populated from filesystem

- **WHEN** the user picks AWS Profile mode
- **THEN** the dropdown options reflect the current return value of `dynamo.listAwsProfiles()`

#### Scenario: SSO profile badge

- **WHEN** a profile in the dropdown has `sso: true`
- **THEN** the option renders an `SSO` badge inline with the profile name

#### Scenario: Test result shown inline

- **WHEN** the user clicks "Test" with valid form fields
- **THEN** the form shows either a green success row with `accountId`, `identityArn`, `latencyMs`, or a red error row with the AWS error code and message

#### Scenario: SSO-expired test result shows copy-command button

- **WHEN** the user clicks "Test" on a profile-mode form whose SSO cache has expired
- **THEN** the error row includes a "Copy command" button that copies `aws sso login --profile <name>` to the clipboard

#### Scenario: Save & Connect

- **WHEN** the user clicks "Save & Connect" with valid form fields
- **THEN** the connection is persisted, the dialog closes, `dynamo.connect(id)` is invoked, and the sidebar reflects the connection as active

#### Scenario: Editing leaves access-keys secret unchanged when blank

- **WHEN** the user opens the form in edit mode for an access-keys connection, modifies `name`, leaves all three credential fields empty, and clicks "Save"
- **THEN** `connections.update` is called with no `secret` field, the keychain entry is untouched, and the row is updated

#### Scenario: Credentials-only sub-mode pre-fills two of three fields

- **WHEN** the form opens in credentials-only sub-mode for a connection whose keychain payload has `access_key_id` and `secret_access_key` set
- **THEN** those two fields are pre-filled, the `session_token` field is empty and focused, and `region`/`endpoint_url`/`read_only`/`name`/`auth` are read-only

### Requirement: Sidebar DynamoDB connection rows

The sidebar's "Connections" section SHALL render each Dynamo connection as a row containing a Dynamo icon (kind-specific, distinct from the Postgres icon), the connection name, a status indicator (green dot when `useActiveConnections()` reports the id as connected, neutral dot when inactive, spinner while a connect call is in flight), and an `RO` badge when `params.read_only` is true. When `params.needs_credentials` is true, the row MUST display a small warning indicator (icon + tooltip "Session token expired").

The row's primary click handler SHALL behave as follows: on an inactive row it initiates `dynamo.connect`; on a row whose connection is in flight it is a no-op; on an active row it performs no destructive action. The row click MUST NOT dispatch `dynamo.disconnect`.

Disconnect MUST be reachable only from a dedicated `⏻` (power) button rendered on every active row, always visible (not hover-only), and sized to be a deliberate target distinct from the row body, or from the row's right-click context menu's `Disconnect` entry.

Right-clicking a row opens a context menu. On an active row the menu includes `Disconnect`, then a separator, then `Edit`, `Duplicate`, and `Delete`. On an inactive row the menu includes only `Edit`, `Duplicate`, and `Delete`. (No `New SQL Query` entry: PartiQL editing lands in change #13.)

The row's subtitle MUST display `region · <accountId>` when the connection is active and `region · <profile name>` or `region · access-keys` when the connection is inactive.

#### Scenario: Click on an inactive row connects

- **WHEN** the user clicks an inactive Dynamo connection row
- **THEN** `dynamo.connect(id)` is invoked; on success the active indicator turns green

#### Scenario: Click on an active row does not disconnect

- **WHEN** the user clicks the body of a Dynamo connection row whose connection is currently active
- **THEN** no `dynamo.disconnect` command is dispatched

#### Scenario: Disconnect button is always visible on active rows

- **WHEN** any Dynamo connection is active
- **THEN** that row renders a `⏻` button regardless of hover state, with a `title`/`aria-label` of "Disconnect"

#### Scenario: needs_credentials warning indicator

- **WHEN** a Dynamo connection's `params.needs_credentials` is `true`
- **THEN** the row displays a warning indicator next to the name with a tooltip explaining "Session token expired"

#### Scenario: RO badge visible when read-only

- **WHEN** a Dynamo connection has `params.read_only: true`
- **THEN** the row displays an `RO` badge next to the name

#### Scenario: Right-click context menu on active row

- **WHEN** the user right-clicks an active Dynamo connection row
- **THEN** a menu appears with `Disconnect`, `Edit`, `Duplicate`, and `Delete`

#### Scenario: Right-click context menu on inactive row

- **WHEN** the user right-clicks an inactive Dynamo connection row
- **THEN** a menu appears with `Edit`, `Duplicate`, and `Delete`

#### Scenario: Delete confirmation

- **WHEN** the user chooses `Delete` from the context menu and confirms
- **THEN** `connections.delete(id)` is invoked, the row disappears, and any active client for that id is dropped via `dynamo.disconnect`

#### Scenario: Subtitle for inactive profile-mode row

- **WHEN** a Dynamo connection is inactive with `auth: "profile"`, `profile: "argus-readonly"`, `region: "us-east-1"`
- **THEN** the row's subtitle reads `us-east-1 · argus-readonly`

#### Scenario: Subtitle for active row

- **WHEN** a Dynamo connection is active with `region: "eu-west-1"` and connect returned `accountId: "123456789012"`
- **THEN** the row's subtitle reads `eu-west-1 · 123456789012`

### Requirement: Disconnect requires confirmation

Activating the per-row `⏻` Disconnect button for a Dynamo connection SHALL open a confirmation dialog before any `dynamo.disconnect` is dispatched. The dialog MUST always be shown. The dialog body MUST adapt to what is open for that connection at the moment the dialog opens:

- A "Disconnect `<name>`?" heading line is always present.
- When one or more tabs belong to that connection, a "N tab(s) will close." line is shown with the exact count.

(There are no dirty edit buffers for Dynamo in this change; that concern lands with #12.)

The dialog footer MUST present a non-destructive Cancel action and a destructive-styled Disconnect action. Cancel MUST close the dialog without dispatching any command. Disconnect MUST dispatch `dynamo.disconnect(connectionId)` and close the dialog.

#### Scenario: Confirm shows even with nothing at risk

- **WHEN** the user clicks `⏻` on an active Dynamo connection that has zero open tabs
- **THEN** the dialog opens with only the heading line and a [Cancel] [Disconnect] footer
- **AND** no `dynamo.disconnect` is dispatched until Disconnect is clicked

#### Scenario: Confirm lists tab count

- **WHEN** the user clicks `⏻` on a Dynamo connection that has 3 open tabs
- **THEN** the dialog body includes a line stating "3 tabs will close."

#### Scenario: Cancel does not disconnect

- **WHEN** the dialog is open and the user clicks Cancel
- **THEN** no `dynamo.disconnect` is dispatched and the dialog closes

### Requirement: Palette commands for DynamoDB connections

The Dynamo module SHALL register the following commands in the `command-palette` registry on app start: `Connection: New DynamoDB…` (opens the form via the kind picker's Dynamo path), `Connection: Test… (DynamoDB)` (tests the currently selected Dynamo connection or, if none selected, opens a chooser listing Dynamo connections), `Connection: Connect… (DynamoDB)` (connects the currently selected Dynamo connection), and `Connection: Disconnect… (DynamoDB)` (disconnects the currently selected Dynamo connection).

#### Scenario: New DynamoDB command opens the form

- **WHEN** the user opens the palette and activates `Connection: New DynamoDB…`
- **THEN** the Dynamo connection form opens with empty fields

#### Scenario: Test command without a selection shows a chooser

- **WHEN** the user activates `Connection: Test… (DynamoDB)` with no sidebar selection
- **THEN** the palette transitions to a chooser listing existing Dynamo connections, and selecting one runs the test

#### Scenario: Connect command targets selected Dynamo connection

- **WHEN** the user selects a Dynamo connection row in the sidebar and activates `Connection: Connect… (DynamoDB)`
- **THEN** `dynamo.connect(id)` is invoked for that connection
