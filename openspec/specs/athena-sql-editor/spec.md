# athena-sql-editor Specification

## Purpose
TBD - created by archiving change add-athena-connection. Update Purpose after archive.
## Requirements
### Requirement: Run SQL command (single statement)

The Athena module SHALL expose a Tauri command `athena_run_sql(connection_id, sql, origin?)` that executes exactly one statement against the connection's active client through the Athena query lifecycle: `StartQueryExecution` (with the connection's `QueryExecutionContext` database, `WorkGroup`, and `ResultConfiguration.OutputLocation` when the workgroup does not enforce one) → poll `GetQueryExecution` until the state is terminal → paginate `GetQueryResults`. The `origin` argument MUST be `"user"` or `"auto"` and defaults to `"user"`. The command MUST classify the statement via the shared `is_mutating_sql` helper: if the statement is mutating (INSERT/CREATE/CTAS/DROP/ALTER/etc.) AND `params.read_only: true`, it MUST return `AppError::Validation { message: "connection is read-only" }` BEFORE calling `StartQueryExecution`.

The response MUST be one of:

- `{ kind: "rows", columns: Array<ColumnInfo>, rows: Array<Array<Value>>, query_ms: number, truncated: boolean, data_scanned_bytes: number }` — for statements that return a result set. Column metadata MUST be derived from `ResultSetMetadata.ColumnInfo`, and the well-known Athena quirk where the first result row of a `SELECT` repeats the column labels MUST be detected and the header row dropped. Cell values arrive as strings and MUST be coerced to the typed `Value` envelope using each column's Athena/Presto type (numeric, boolean, timestamp/date, null when absent, otherwise string). `truncated: true` indicates the row count hit the cap (see "Result row cap and pagination").
- `{ kind: "succeeded", statement_type: string, query_ms: number, data_scanned_bytes: number }` — for DDL/DML that returns no result set (e.g. `CREATE`, `INSERT`, `MSCK REPAIR`). `statement_type` MUST reflect the Athena `StatementType` (`DDL`, `DML`, `UTILITY`).

On query failure (Athena state `FAILED`/`CANCELLED`) the command MUST return `AppError::Aws` whose message is the Athena `StateChangeReason` verbatim. The command SHALL emit exactly one `argus:activity-log` event with `kind: "run_sql"`, `origin`, `sql`, and a success/failure `status`.

#### Scenario: SELECT returns rows envelope with header row dropped

- **WHEN** the user invokes `athena.runSql(id, "SELECT id, name FROM db.users LIMIT 5", "user")`
- **THEN** the response is `{ kind: "rows", columns: [{ name: "id", ... }, { name: "name", ... }], rows: [[...], ...], query_ms, truncated: false, data_scanned_bytes }`
- **AND** the first `GetQueryResults` row that duplicates the column labels is NOT present in `rows`
- **AND** one activity-log event is emitted with `status: "ok"`

#### Scenario: Typed coercion from string cells

- **WHEN** a SELECT returns an `integer` column and a `boolean` column
- **THEN** the integer cells are emitted as JSON numbers and the boolean cells as JSON booleans, not strings
- **AND** a `NULL` cell (absent `VarCharValue`) is emitted as JSON `null`

#### Scenario: CREATE returns succeeded envelope

- **WHEN** the user invokes `athena.runSql(id, "CREATE TABLE db.t AS SELECT 1", "user")` against a writable connection
- **THEN** the response is `{ kind: "succeeded", statement_type: "DDL" | "DML", query_ms, data_scanned_bytes }`

#### Scenario: Mutation on read-only connection rejected before dispatch

- **WHEN** the user invokes `athena.runSql(id, "DROP TABLE db.t", "user")` and the connection has `params.read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }`
- **AND** `StartQueryExecution` is NOT called
- **AND** an activity-log event is emitted with `status: "err"`

#### Scenario: Query failure surfaces the Athena reason

- **WHEN** a submitted query reaches Athena state `FAILED` with a `StateChangeReason`
- **THEN** the command returns `AppError::Aws` whose message contains that reason verbatim

### Requirement: Result row cap and pagination

`athena_run_sql` MUST page through `GetQueryResults` (which returns up to 1000 rows per page) accumulating rows until a fixed cap is reached, then stop and set `truncated: true`. The accumulated bytes-scanned figure MUST be read from `GetQueryExecution.Statistics.DataScannedInBytes` and returned as `data_scanned_bytes` so the editor can display query cost.

#### Scenario: Large result set is capped and flagged

- **WHEN** a query returns more rows than the cap
- **THEN** `rows` contains exactly the cap and `truncated` is `true`

#### Scenario: Bytes scanned reported

- **WHEN** any query completes successfully
- **THEN** `data_scanned_bytes` reflects the Athena-reported scanned bytes for that execution

### Requirement: Cancel running query

The Athena module SHALL expose a Tauri command `athena_cancel_query(connection_id, query_execution_id)` that calls `StopQueryExecution`. While `athena_run_sql` is polling, the frontend MUST be able to cancel the in-flight execution; on cancellation the run resolves as a cancelled/aborted outcome rather than a row set.

#### Scenario: User cancels a long-running query

- **WHEN** a query is `RUNNING` and the user cancels it
- **THEN** `StopQueryExecution` is called for that `QueryExecutionId` and the editor reports the run as cancelled

### Requirement: Multi-statement run (sequential executions)

The Athena module SHALL expose `athena_run_sql_many(connection_id, statements, origin?)` that splits/accepts multiple statements (reusing the SQL splitter) and runs each as a separate `StartQueryExecution` sequentially, stopping at the first failure (remaining statements marked skipped). The response MUST be a `{ outcomes: Array<{ index, sql, ... }> }` envelope analogous to `mysql_run_sql_many`, with each outcome carrying its own `data_scanned_bytes`.

#### Scenario: Two statements run sequentially

- **WHEN** the user runs two statements in one batch against a writable connection
- **THEN** each is executed as its own Athena query in order and both outcomes are returned with their own bytes-scanned

#### Scenario: Failure stops the batch

- **WHEN** the first of three statements fails
- **THEN** its outcome is an error and the remaining two are marked skipped (not executed)

### Requirement: Result export

The Athena SQL editor SHALL offer export of the current result set to CSV, JSONL, and XLSX, reusing the existing export utilities and save flow used by the MySQL editor.

#### Scenario: Export to CSV

- **WHEN** the user exports a result set as CSV
- **THEN** a CSV file is written via the existing `saveExport` flow with the result columns and rows

### Requirement: AI-assisted SQL generation grounded in the context folder

The Athena SQL editor SHALL expose the ✨ AI chat panel (the same docked panel used by the Postgres SQL editor). When the connection has a linked context folder, the chat request MUST carry that folder's documentation and prefab queries so the AI agent generates Athena/Presto-dialect SQL against the real schema, following the existing SQL-only, context-folder-first guardrails. Executed Athena results MUST be attachable to the next message via the existing "Attach result" composer chip (capped, session-only, never persisted).

#### Scenario: AI panel available in the Athena editor

- **WHEN** the user opens the Athena SQL editor toolbar
- **THEN** the ✨ button toggles the docked AI chat panel, and "AI: Focus chat panel" can open it from the command palette

#### Scenario: Generated SQL uses the linked context folder

- **WHEN** the user asks the AI to write a query and the Athena connection has a linked context folder
- **THEN** the chat request includes the context-folder content and the agent returns SQL consistent with the documented schema

#### Scenario: Attach executed Athena result as context

- **WHEN** the user runs a query and clicks "Attach result", then sends a follow-up message
- **THEN** the attached result (within the existing row/byte caps) rides the request's `attached_results` field and is not persisted

### Requirement: Visible Stop affordance for a running query

The Athena SQL editor SHALL expose the already-present cancel path to the user: `useAthenaQueryRun` SHALL provide a `cancel()` method that, using the `query_execution_id` captured from the `athena:query-started` event, calls `athenaApi.cancelQuery` (`athena_cancel_query` → `StopQueryExecution`); and the editor toolbar SHALL render a Stop control (plus cancel shortcut) while a query is running. On cancel the editor SHALL return to idle showing a neutral cancelled state rather than rows or an error block.

#### Scenario: User cancels a running Athena query from the toolbar

- **WHEN** an Athena query is `QUEUED`/`RUNNING` and the user clicks the Stop control (or presses the cancel shortcut)
- **THEN** `StopQueryExecution` is called for the captured `QueryExecutionId` and the editor returns to idle showing "Query cancelled"
- **AND** no result rows and no error block are displayed

#### Scenario: Stop control only shown while running

- **WHEN** no Athena query is running
- **THEN** the toolbar shows Run, not Stop

