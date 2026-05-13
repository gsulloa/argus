## MODIFIED Requirements

### Requirement: Read-only enforcement contract

The Dynamo module's active-client envelope SHALL carry a snapshot of `params.read_only` taken at connect time. The module SHALL expose an internal helper `require_writable(connection_id) -> AppResult<()>` that returns `AppError::Validation { message: "connection is read-only" }` when the snapshot is `true`, and `Ok(())` otherwise. Every mutating Dynamo command MUST call `require_writable` before dispatching any request to the AWS API. The commands obligated to call `require_writable` MUST include, at minimum, `dynamo.put_item`, `dynamo.update_item`, and `dynamo.delete_item`; any future mutating Dynamo command MUST be added to this list when introduced. The Dynamo module MUST NOT expose a raw client accessor that bypasses this contract.

#### Scenario: Helper rejects mutation on read-only client

- **WHEN** any caller invokes `require_writable(id)` for a connection whose active-client envelope has `read_only: true`
- **THEN** the helper returns `AppError::Validation` with message `"connection is read-only"`

#### Scenario: Helper allows mutation on writable client

- **WHEN** any caller invokes `require_writable(id)` for a connection with `read_only: false`
- **THEN** the helper returns `Ok(())`

#### Scenario: Helper rejects with NotFound for unknown id

- **WHEN** any caller invokes `require_writable(id)` for an id without a registered client
- **THEN** the helper returns `AppError::NotFound`

#### Scenario: put_item calls require_writable

- **WHEN** `dynamo.put_item` is invoked for a connection whose active-client envelope has `read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }` before any AWS call is made

#### Scenario: update_item calls require_writable

- **WHEN** `dynamo.update_item` is invoked for a connection whose active-client envelope has `read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }` before any AWS call is made

#### Scenario: delete_item calls require_writable

- **WHEN** `dynamo.delete_item` is invoked for a connection whose active-client envelope has `read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }` before any AWS call is made
