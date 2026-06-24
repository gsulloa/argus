## ADDED Requirements

### Requirement: Workspace identity header shows the AWS region for DynamoDB connections

The Workspace sidebar identity header SHALL display the active AWS region of a focused **DynamoDB** connection as connection metadata, rendered in the existing identity metadata row (alongside the engine label and the environment indicator dot). The region MUST be the focused connection's **runtime** region as reported by the active connection (`ActiveDynamoConnection.region`). When the connection is not currently active, the header SHALL fall back to the region configured in the connection's params (`DynamoParams.region`). When no region can be resolved from either source, the header MUST render no region content and MUST NOT error or show an empty placeholder.

The region content MUST follow `DESIGN.md` (typography, spacing, color of the header metadata row) and read as quiet metadata, not as a prominent badge. This requirement applies only to the `dynamodb` engine kind; the identity header of all other engine kinds MUST be unchanged.

#### Scenario: Active DynamoDB connection shows its runtime region

- **WHEN** a DynamoDB connection that is currently active in region `us-east-1` is focused in the Workspace
- **THEN** the identity header shows `us-east-1` in the identity metadata row
- **AND** it still shows the DynamoDB engine label and the environment indicator dot

#### Scenario: Region reflects the active connection, not stale form input

- **WHEN** a DynamoDB connection is active in region `us-west-2`
- **THEN** the identity header shows `us-west-2`
- **AND** the displayed region matches the region the app is querying against

#### Scenario: Inactive DynamoDB connection falls back to configured region

- **WHEN** a DynamoDB connection that is not currently active is focused, and its params specify region `eu-central-1`
- **THEN** the identity header shows `eu-central-1` from the connection params

#### Scenario: No region available renders cleanly

- **WHEN** a focused DynamoDB connection has no resolvable region from the active connection or its params
- **THEN** the identity header renders the connection identity without any region content and without error

#### Scenario: Non-DynamoDB engines show no region

- **WHEN** a focused connection is any engine kind other than DynamoDB (e.g. Postgres, MySQL, MSSQL, Athena, CloudWatch)
- **THEN** the identity header does not show an AWS region added by this change
