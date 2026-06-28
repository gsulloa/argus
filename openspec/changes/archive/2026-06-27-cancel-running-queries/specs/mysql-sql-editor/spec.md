## ADDED Requirements

### Requirement: Cancel a running query

The MySQL module SHALL allow a user-initiated run (`mysql_run_sql` / `mysql_run_sql_many`) to be cancelled. The run command SHALL accept a frontend-generated `run_token`, capture the connection thread id via `capture_thread_id` and register a cancel action (`fire_mysql_cancel(params, secret, thread_id)`, i.e. `KILL QUERY <thread_id>` on a fresh connection) in the shared in-flight registry. On `cancel_running_query(run_token)` the action SHALL fire and the run SHALL resolve as cancelled. The editor SHALL present a Stop control and cancel shortcut while running and return to idle on cancel.

#### Scenario: User cancels a long-running statement

- **WHEN** a `SELECT SLEEP(30)` is running and the user clicks Stop (or presses the cancel shortcut)
- **THEN** `KILL QUERY <thread_id>` is issued on a fresh connection, the statement is interrupted, and the editor returns to idle showing "Query cancelled"
- **AND** no result rows and no error block are displayed

#### Scenario: Cancel during a multi-statement run

- **WHEN** the user cancels while `mysql_run_sql_many` is executing statement *k*
- **THEN** the in-flight statement is aborted, the batch stops, and the whole run resolves to the neutral cancelled state (no error block, no partial rows)
