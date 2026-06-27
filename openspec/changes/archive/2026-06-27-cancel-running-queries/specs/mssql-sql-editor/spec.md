## ADDED Requirements

### Requirement: Cancel a running query

The MSSQL module SHALL allow a user-initiated run (`mssql_run_sql` / `mssql_run_sql_many` / batch) to be cancelled. The run command SHALL accept a frontend-generated `run_token`, capture `@@SPID` (as `run_cancellable_query` already does), and register a cancel action (`fire_mssql_cancel(spid, params, password)`, i.e. `KILL <spid>` on a fresh connection) in the shared in-flight registry. On `cancel_running_query(run_token)` the action SHALL fire and the run SHALL resolve as cancelled. The editor SHALL present a Stop control and cancel shortcut while running and return to idle on cancel.

#### Scenario: User cancels a long-running statement

- **WHEN** a `WAITFOR DELAY '00:00:30'` is running and the user clicks Stop (or presses the cancel shortcut)
- **THEN** `KILL <spid>` is issued on a fresh connection, the statement is interrupted, and the editor returns to idle showing "Query cancelled"
- **AND** no result rows and no error block are displayed

#### Scenario: Cancel during a multi-statement run

- **WHEN** the user cancels while a multi-statement / `GO`-batch run is executing statement *k*
- **THEN** the in-flight statement is aborted, the batch stops, and the whole run resolves to the neutral cancelled state (no error block, no partial rows)
