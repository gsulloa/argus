# athena-connection Specification

## Purpose
TBD - created by archiving change add-athena-connection. Update Purpose after archive.
## Requirements
### Requirement: Athena connection params shape

The Athena module SHALL define and own a typed params shape: `{ region: string, workgroup: string, output_location?: string, auth: "profile" | "access_keys", profile?: string, read_only: boolean }`. When a connection is created or updated with `kind: "athena"`, the Athena module MUST validate the params before persistence and reject invalid values with `AppError::Validation`. The platform's `connection-registry` continues to treat `params` as opaque JSON; only the Athena module reads it. AWS credentials are never stored in `params` — for `access_keys` auth they live in the OS keychain as the connection secret (same JSON shape as DynamoDB: `{ access_key_id, secret_access_key, session_token? }`); for `profile` auth the named profile is resolved from `~/.aws`.

#### Scenario: Valid params round-trip

- **WHEN** the user creates an Athena connection with `region: "us-east-1"`, `workgroup: "primary"`, `output_location: "s3://my-results/athena/"`, `auth: "profile"`, `profile: "default"`, `read_only: true`
- **THEN** the connection is persisted via `connections.create` and `connections.list` returns the same params shape

#### Scenario: Empty region rejected

- **WHEN** the user submits Athena params with `region: ""` or a value not in the supported AWS region list
- **THEN** the Athena module returns `AppError::Validation` and no row is created

#### Scenario: Empty workgroup rejected

- **WHEN** the user submits Athena params with `workgroup: ""` (empty or whitespace only)
- **THEN** the Athena module returns `AppError::Validation` and no row is created

#### Scenario: Output location required when workgroup does not enforce it

- **WHEN** the user submits Athena params with `output_location` empty and the connection is later used to run a query in a workgroup that does not enforce an output location
- **THEN** `StartQueryExecution` returns an Athena error surfaced as `AppError::Aws` whose message explains that an S3 output location is required
- **AND** when `output_location` is provided it MUST be a valid `s3://` URI or the params are rejected with `AppError::Validation`

#### Scenario: Profile auth requires a profile name

- **WHEN** the user submits Athena params with `auth: "profile"` and `profile` empty
- **THEN** the Athena module returns `AppError::Validation`

#### Scenario: read_only defaults to false

- **WHEN** the user submits Athena params without an explicit `read_only` field
- **THEN** the persisted row has `read_only: false`

### Requirement: AWS profile enumeration reused

The Athena connection form SHALL reuse the existing AWS profile enumeration (`list_profiles`) so the user can pick a named profile from `~/.aws/credentials` and `~/.aws/config`, with the same SSO-detection and region hints already used by the DynamoDB form.

#### Scenario: Profiles listed for the form

- **WHEN** the Athena connection form requests available AWS profiles
- **THEN** it receives the same `ProfileInfo[]` shape (`{ name, sso, region? }`) returned to the DynamoDB form

### Requirement: Test connection command

The Athena module SHALL expose a Tauri command `athena_test_connection(params, secret?)` that builds an Athena (and Glue) client with the resolved credentials, performs a lightweight identity/capability check (e.g. `sts:GetCallerIdentity` and/or `athena:GetWorkGroup` for the configured workgroup), and returns either `{ ok: true, latencyMs: number, accountId: string }` or `{ ok: false, error: AppError }`. The command MUST timeout after a bounded interval and MUST NOT persist anything. It SHALL emit exactly one `argus:activity-log` event with `kind: "test_connection"`, `connection_id: null`, `origin: "user"` before returning.

#### Scenario: Successful test against a reachable workgroup

- **WHEN** the user fills the form with valid credentials and a reachable workgroup and clicks "Test"
- **THEN** the command returns `{ ok: true, latencyMs, accountId }` and emits one activity-log event with `status: "ok"`

#### Scenario: Expired or invalid credentials

- **WHEN** the credentials are expired or invalid
- **THEN** the command returns `{ ok: false, error }` where `error` is `AppError::Aws` and, for expired access-keys/SSO, carries the same remediation hints used by DynamoDB (e.g. `aws sso login --profile <name>`)

### Requirement: Connection lifecycle and active-client registry

The Athena module SHALL maintain an `AthenaClientRegistry` (an in-memory map keyed by connection `Uuid`, analogous to `DynamoClientRegistry` rather than a `sqlx` pool, since Athena has no persistent connection) and expose Tauri commands `athena_connect(id)`, `athena_disconnect(id)`, `athena_disconnect_all()`, and `athena_list_active()`. `athena_connect` MUST load params + secret from the connection registry, build and verify the client, store it in the registry, and emit an `athena:active-changed` event. `athena_list_active` MUST return a snapshot including at least `{ id, region, account_id, read_only, connected_at_unix_ms }`.

#### Scenario: Connect registers an active client

- **WHEN** the user activates a saved Athena connection via `athena_connect(id)`
- **THEN** the registry holds an active client for `id`, `athena_list_active()` includes it, and an `athena:active-changed` event is emitted

#### Scenario: Connect is idempotent

- **WHEN** `athena_connect(id)` is invoked for a connection that is already active
- **THEN** the command succeeds without creating a second client

#### Scenario: Disconnect removes the active client

- **WHEN** the user invokes `athena_disconnect(id)` on an active connection
- **THEN** the client is removed from the registry and an `athena:active-changed` event is emitted

#### Scenario: Disconnect of an unknown id is a no-op

- **WHEN** `athena_disconnect(id)` is invoked for an id with no active client
- **THEN** the command succeeds without error and emits no spurious change

