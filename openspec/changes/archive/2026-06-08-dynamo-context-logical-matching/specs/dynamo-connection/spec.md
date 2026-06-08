## MODIFIED Requirements

### Requirement: DynamoDB connection params shape

The Dynamo module SHALL define and own a typed params shape: `{ auth: "access_keys" | "profile", profile?: string, region: string, endpoint_url?: string, read_only: boolean, needs_credentials?: boolean, table_match?: TableMatch }`. The optional `table_match` carries the table-name normalization rule (see `dynamo-table-name-normalization`) in one of two mutually-exclusive forms: a simple form `{ prefix?: string, suffix_pattern?: string }` or an advanced form `{ regex: string }` whose pattern MUST contain a named capture group `logical`. When a connection is created or updated with `kind: "dynamodb"`, the Dynamo module MUST validate the params before persistence and reject invalid values with `AppError::Validation`. Validation MUST reject a `suffix_pattern` or `regex` that does not compile, and MUST reject an advanced-form `regex` that lacks a `logical` capture group. An absent or empty `table_match` is valid and means identity (exact match). The platform's `connection-registry` continues to treat `params` as opaque JSON; only the Dynamo module reads it.

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

#### Scenario: Valid table_match round-trips

- **WHEN** the user creates a Dynamo connection with `table_match: { prefix: "MyApp-prod-", suffix_pattern: "-[A-Z0-9]+$" }`
- **THEN** the connection is persisted and `connections.list` returns the same `table_match` shape

#### Scenario: Malformed table_match regex rejected

- **WHEN** the user submits Dynamo params with `table_match: { suffix_pattern: "-[A-Z0-9" }` (an unbalanced, non-compiling regex)
- **THEN** the Dynamo module returns `AppError::Validation` and no row is created

#### Scenario: Advanced-form regex without logical group rejected

- **WHEN** the user submits Dynamo params with `table_match: { regex: "^MyApp-prod-.+$" }` (compiles but has no `logical` capture group)
- **THEN** the Dynamo module returns `AppError::Validation` with a message naming the missing group

#### Scenario: Absent table_match is valid

- **WHEN** the user creates a Dynamo connection with no `table_match` field
- **THEN** the connection is persisted and matching behaves as exact (identity), unchanged from before this change
