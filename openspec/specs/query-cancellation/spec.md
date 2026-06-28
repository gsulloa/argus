# query-cancellation Specification

## Purpose
TBD - created by archiving change cancel-running-queries. Update Purpose after archive.
## Requirements
### Requirement: In-flight query registry

The backend SHALL maintain a shared `RunningQueryRegistry` (Tauri managed state) mapping a run token (`Uuid`) to a cancel entry that holds (a) a best-effort async cancel action and (b) a `cancel_requested` flag. A run command that supports cancellation SHALL register its entry under the run token before awaiting the query body and SHALL remove the entry on every exit path (success, error, or panic) via an RAII guard.

#### Scenario: Entry registered and cleaned up on success

- **WHEN** a cancellable run command begins executing with run token `T`
- **THEN** an entry for `T` exists in the registry while the query is in flight
- **AND** the entry for `T` is removed once the command returns, regardless of outcome

#### Scenario: Entry cleaned up on error

- **WHEN** a cancellable run errors before completing
- **THEN** its registry entry is removed (no leaked entries remain for that token)

### Requirement: Cancel command aborts the in-flight run

The backend SHALL expose `cancel_running_query(run_token)` that, when an entry for the token exists, sets its `cancel_requested` flag and awaits its cancel action best-effort. The command SHALL be idempotent and SHALL never error when the token is unknown or the query has already finished (it returns successfully as a no-op). The cancel action SHALL stop the work server-side using the engine's native primitive (Postgres `CancelToken`, MySQL `KILL QUERY <thread_id>`, MSSQL `KILL <spid>`), never merely drop the local task.

#### Scenario: Cancel a running query

- **WHEN** a query is in flight under run token `T` and `cancel_running_query(T)` is invoked
- **THEN** the engine's native cancel primitive is fired against the running statement
- **AND** the in-flight run command resolves as cancelled rather than returning rows

#### Scenario: Cancel after the query already finished is a no-op

- **WHEN** `cancel_running_query(T)` is invoked but no entry for `T` exists (already completed or never registered)
- **THEN** the command returns successfully without error and has no effect

#### Scenario: Double cancel is idempotent

- **WHEN** `cancel_running_query(T)` is invoked twice for the same in-flight run
- **THEN** both calls return successfully and the run resolves cancelled exactly once

### Requirement: Cancellation classified by intent, not driver error

When a cancellable run's query future errors, the run command SHALL report a cancelled outcome if and only if `cancel_requested` was set for its run token; otherwise it SHALL report the error normally. Classification SHALL NOT depend on parsing driver-specific error codes or message text.

#### Scenario: User-cancelled run reports cancelled

- **WHEN** the user has requested cancel for token `T` and the query future then errors (because the statement was killed)
- **THEN** the run resolves as cancelled, not as a query error

#### Scenario: Genuine error without cancel reports an error

- **WHEN** a query errors and no cancel was requested for its token
- **THEN** the run resolves with the original error envelope unchanged

### Requirement: Cancellation surfaces as a neutral, non-error result

A cancelled run SHALL be signalled to the frontend with a recognizable cancelled marker (an `AppError` with code `"Cancelled"` or an equivalent cancelled result) that the frontend maps to a neutral terminal "cancelled" state. The frontend SHALL NOT render a cancelled run as a red error block and SHALL NOT display partial rows from the aborted statement.

#### Scenario: Cancelled run shows a neutral state

- **WHEN** a run resolves cancelled
- **THEN** the editor returns to idle/ready and the status reads "Query cancelled" (or equivalent)
- **AND** no error block and no partial result rows are shown

### Requirement: Run⇄Stop affordance in the editor toolbar

While a user-initiated query is running, a SQL editor that supports cancellation SHALL present a visible Stop control (the Run button becomes/accompanies a Stop action) and a keyboard shortcut to cancel. Triggering either SHALL invoke the cancel path for the current run and return the editor to idle.

#### Scenario: Stop button visible while running

- **WHEN** a query is running in a cancellation-supporting editor
- **THEN** a Stop control is visible and enabled in the toolbar
- **AND** when no query is running, the control shows Run instead of Stop

#### Scenario: Cancel via keyboard shortcut

- **WHEN** a query is running and the user presses the cancel shortcut
- **THEN** the current run is cancelled and the editor returns to idle

### Requirement: Frontend-generated run token for synchronous engines

For the synchronous engines (Postgres, MySQL, MSSQL), the frontend SHALL generate a run token and pass it to the run command so the run can be correlated and cancelled without waiting for a backend event. Asynchronous engines (Athena, CloudWatch) MAY continue to correlate via their existing `*:query-started` events that carry the server-assigned execution/query id.

#### Scenario: Token known before the run resolves

- **WHEN** the frontend starts a synchronous-engine run
- **THEN** it holds the run token before the run command returns
- **AND** a Stop pressed at any point during the run can call `cancel_running_query` with that token
