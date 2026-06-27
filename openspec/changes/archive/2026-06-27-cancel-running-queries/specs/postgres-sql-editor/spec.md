## ADDED Requirements

### Requirement: Cancel a running query

The Postgres module SHALL allow a user-initiated run (`postgres_run_sql` / `postgres_run_sql_many`) to be cancelled. The run command SHALL accept a frontend-generated `run_token`, register its `client.cancel_token()` in the shared in-flight registry under that token, and on `cancel_running_query(run_token)` fire the cancel token (Postgres cancel-request protocol) so the server aborts the statement. The run SHALL then resolve as cancelled. The editor SHALL present a Stop control and cancel shortcut while running and return to idle on cancel.

#### Scenario: User cancels a long-running statement

- **WHEN** a `SELECT pg_sleep(30)` is running and the user clicks Stop (or presses the cancel shortcut)
- **THEN** `cancel_running_query` fires the connection's cancel token, the server aborts the query, and the editor returns to idle showing "Query cancelled"
- **AND** no result rows and no error block are displayed

#### Scenario: Cancel during a multi-statement run

- **WHEN** the user cancels while `postgres_run_sql_many` is executing statement *k*
- **THEN** the in-flight statement is aborted, the batch stops, and the whole run resolves to the neutral cancelled state (no error block, no partial rows)
