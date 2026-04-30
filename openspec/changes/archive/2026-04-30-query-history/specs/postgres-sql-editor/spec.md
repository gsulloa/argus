## ADDED Requirements

### Requirement: Run commands persist a query-history row per executed statement

In the SAME execution path where `postgres_run_sql` and `postgres_run_sql_many` emit their `argus:activity-log` events, the platform MUST also persist a row to the `query_history` SQLite table per the `query-history` capability — exactly one row per emitted `kind: "run_sql"` event. This includes failed statements (`status: "err"`) and excludes statements that were skipped because an earlier statement failed in a multi-run.

The persistence MUST happen before the run command returns to the frontend, MUST run on the same Tauri command thread (no async task spawn), and MUST NOT mask the SQL execution outcome: any error from the `query_history` insert MUST be logged to stderr but MUST NOT propagate as the command's response. The user-visible behavior of `postgres_run_sql` and `postgres_run_sql_many` (return shape, activity-log events, read-only enforcement, row cap) is otherwise unchanged.

The persisted row's fields are owned by the `query-history` capability spec; this requirement only fixes the trigger point and the 1:1 correspondence with activity-log events.

#### Scenario: Each successful run produces one history row

- **WHEN** the user invokes `postgres.runSql(id, "SELECT 1", "user")` against a writable connection
- **THEN** the count of `query_history` rows increases by exactly 1
- **AND** that row's `sql` is `"SELECT 1"`, `status` is `"ok"`, `origin` is `"user"`

#### Scenario: Each failed run still produces one history row

- **WHEN** the user invokes `postgres.runSql(id, "SELEC 1", "user")` and Postgres returns SQLSTATE `42601`
- **THEN** the count of `query_history` rows increases by exactly 1
- **AND** that row has `status: "err"`, `error_code: "42601"`

#### Scenario: Run-many writes one row per executed step, none for skipped

- **WHEN** the user invokes `postgres.runSqlMany(id, ["SELECT 1", "SELEC 2", "SELECT 3"], "user")`
- **THEN** the count of `query_history` rows increases by exactly 2 (one ok, one err)
- **AND** no row is written for the third (skipped) statement

#### Scenario: Run-many with all successes writes one row per statement

- **WHEN** the user invokes `postgres.runSqlMany(id, ["SELECT 1", "SELECT 2", "SELECT 3"], "user")`
- **THEN** the count of `query_history` rows increases by exactly 3, each with `status: "ok"`

#### Scenario: A failure to persist history does not fail the run

- **WHEN** the SQL execution succeeds but the subsequent `query_history` insert fails (for example, SQLite is locked)
- **THEN** the run command still returns the successful `RunSqlResult` to the frontend
- **AND** an error is logged to stderr describing the persistence failure
