## ADDED Requirements

### Requirement: CloudWatch connection params shape

The CloudWatch module SHALL define and own a typed params shape: `{ region: string, auth: "profile" | "access_keys", profile?: string }`. When a connection is created or updated with `kind: "cloudwatch"`, the CloudWatch module MUST validate the params before persistence and reject invalid values with `AppError::Validation`. The platform's `connection-registry` continues to treat `params` as opaque JSON; only the CloudWatch module reads it. AWS credentials are never stored in `params` — for `access_keys` auth they live in the OS keychain as the connection secret (same JSON shape as DynamoDB: `{ access_key_id, secret_access_key, session_token? }`); for `profile` auth the named profile is resolved from `~/.aws`. The params carry **no `read_only` flag** because CloudWatch Logs is read-only in Argus (no command mutates logs).

#### Scenario: Valid params round-trip

- **WHEN** the user creates a CloudWatch connection with `region: "us-east-1"`, `auth: "profile"`, `profile: "default"`
- **THEN** the connection is persisted via `connections.create` and `connections.list` returns the same params shape

#### Scenario: Empty or unknown region rejected

- **WHEN** the user submits CloudWatch params with `region: ""` or a value not in the supported AWS region list
- **THEN** the CloudWatch module returns `AppError::Validation` and no row is created

#### Scenario: Profile auth requires a profile name

- **WHEN** the user submits CloudWatch params with `auth: "profile"` and `profile` empty
- **THEN** the CloudWatch module returns `AppError::Validation`

#### Scenario: Access-keys auth requires a keychain secret

- **WHEN** the user submits CloudWatch params with `auth: "access_keys"` and the secret is missing or does not contain `access_key_id` and `secret_access_key`
- **THEN** the CloudWatch module returns `AppError::Validation` and no row is created

### Requirement: AWS profile enumeration reused

The CloudWatch connection form SHALL reuse the existing AWS profile enumeration (`dynamo::aws_profiles::list_profiles`) so the user can pick a named profile from `~/.aws/credentials` and `~/.aws/config`, with the same SSO-detection and region hints already used by the DynamoDB and Athena forms. No new profile-listing command is added.

#### Scenario: Profiles listed for the form

- **WHEN** the CloudWatch connection form requests available AWS profiles
- **THEN** it receives the same `ProfileInfo[]` shape (`{ name, sso, region? }`) returned to the DynamoDB form

### Requirement: Test connection command

The CloudWatch module SHALL expose a Tauri command `cloudwatch_test_connection(params, secret?)` that builds a CloudWatch Logs client with the resolved credentials, performs a lightweight identity check (`sts:GetCallerIdentity`), and returns either `{ ok: true, latencyMs: number, accountId: string }` or `{ ok: false, error: AppError }`. The command MUST time out after a bounded interval and MUST NOT persist anything. It SHALL emit exactly one `argus:activity-log` event with `kind: "test_connection"`, `connection_id: null`, `origin: "user"` before returning.

#### Scenario: Successful test against reachable credentials

- **WHEN** the user fills the form with valid credentials and a reachable region and clicks "Test"
- **THEN** the command returns `{ ok: true, latencyMs, accountId }` and emits one activity-log event with `status: "ok"`

#### Scenario: Expired or invalid credentials

- **WHEN** the credentials are expired or invalid
- **THEN** the command returns `{ ok: false, error }` where `error` is `AppError::Aws` and, for expired access-keys/SSO, carries the same remediation hints used by DynamoDB (e.g. `aws sso login --profile <name>`)

### Requirement: Connection lifecycle and active-client registry

The CloudWatch module SHALL maintain a `CloudwatchClientRegistry` (an in-memory map keyed by connection `Uuid`, analogous to `DynamoClientRegistry`, since CloudWatch has no persistent connection) and expose Tauri commands `cloudwatch_connect(id)`, `cloudwatch_disconnect(id)`, `cloudwatch_disconnect_all()`, and `cloudwatch_list_active()`. `cloudwatch_connect` MUST load params + secret from the connection registry, build and verify the client, store it in the registry, and emit a `cloudwatch:active-changed` event. `cloudwatch_list_active` MUST return a snapshot including at least `{ id, region, account_id, connected_at_unix_ms }`.

#### Scenario: Connect registers an active client

- **WHEN** the user activates a saved CloudWatch connection via `cloudwatch_connect(id)`
- **THEN** the registry holds an active client for `id`, `cloudwatch_list_active()` includes it, and a `cloudwatch:active-changed` event is emitted

#### Scenario: Connect is idempotent

- **WHEN** `cloudwatch_connect(id)` is invoked for a connection that is already active
- **THEN** the command succeeds without creating a second client

#### Scenario: Disconnect removes the active client

- **WHEN** the user invokes `cloudwatch_disconnect(id)` on an active connection
- **THEN** the client is removed from the registry and a `cloudwatch:active-changed` event is emitted

#### Scenario: Disconnect of an unknown id is a no-op

- **WHEN** `cloudwatch_disconnect(id)` is invoked for an id with no active client
- **THEN** the command succeeds without error and emits no spurious change
