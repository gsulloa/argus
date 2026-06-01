# mssql-sql-editor Specification

## Purpose
TBD - created by archiving change add-mssql-support. Update Purpose after archive.
## Requirements
### Requirement: Run SQL command (single statement)

The MS SQL Server module SHALL expose a Tauri command `mssql_run_sql(connection_id, sql, origin?)` that executes exactly one SQL statement (or one `GO`-delimited batch — see "Statement splitting") against the connection's pool and returns a discriminated `RunSqlResult` payload. The `origin` argument MUST be `"user"` or `"auto"` and defaults to `"user"` when absent. The command MUST acquire a connection from the existing `MssqlPoolRegistry`, MUST NOT open a new connection, and MUST classify the statement via the shared `is_mutating_sql` helper (extended for MS SQL Server keywords):

- If the statement is non-mutating (SELECT, WITH-only-reads, SHOW-like via `sp_help`, `EXEC sp_*` read-only catalog procs, `SET SHOWPLAN_TEXT`, etc.), it MUST execute through the pool's read-only-aware `mssql_execute_query` path.
- If the statement is mutating (INSERT, UPDATE, DELETE, MERGE, TRUNCATE, DDL, GRANT/REVOKE/DENY, EXEC of an unknown proc) AND the connection has `params.read_only: true`, the command MUST return `AppError::Validation { message: "connection is read-only" }` BEFORE dispatching the SQL to the server.
- Otherwise the statement MUST execute through `mssql_execute_mutation`.

The response MUST be one of:

- `{ kind: "rows", columns: Array<ColumnInfo>, rows: Array<Array<Value>>, query_ms: number, truncated_columns: string[], truncated: boolean }` — used when the statement returns a row set (any SELECT, `sp_help`, `SET SHOWPLAN_TEXT`, etc.). The `columns`, `rows`, and `truncated_columns` fields MUST follow the same shape as `mssql_query_table` (snake_case keys, same `Value` envelope handling for binary/truncated cells). `truncated: true` indicates the row count hit the cap (see "Result row cap").
- `{ kind: "affected", command_tag: string, affected_rows: number, query_ms: number }` — used when the statement returns no rows. `command_tag` MUST be the MS SQL Server command name derived from the first keyword of the statement (e.g. `"INSERT"`, `"UPDATE"`, `"DELETE"`, `"MERGE"`, `"CREATE TABLE"`, `"ALTER TABLE"`, `"DROP TABLE"`, `"TRUNCATE TABLE"`, `"USE"`, `"SET"`, `"GRANT"`, `"REVOKE"`, `"DENY"`, `"EXEC"`, `"DECLARE"`, `"BEGIN TRAN"`, `"COMMIT"`, `"ROLLBACK"`, `"BACKUP"`). `affected_rows` MUST be the integer reported by the tiberius driver (sourced from `@@ROWCOUNT` or the `DONE` token; 0 when not applicable, e.g. for most DDL).

On error the command MUST return `AppError::Mssql { code: Option<i32>, message: String, line: Option<u32>, procedure: Option<String> }` where:

- `code` is the numeric SQL Server error number reported by the server (e.g. `208` for invalid object name, `207` for invalid column name, `102` for syntax error). `code` is `None` when the failure is a transport/protocol/driver error with no server-side payload.
- `message` is the server-supplied error message verbatim (see "MS SQL Server message surfaces verbatim in error envelope").
- `line` is the 1-based line number the SQL Server engine reports for the failing token (sourced from the TDS error token's line field). `line` is `None` when the server does not report a line.
- `procedure` is the name of the stored procedure or trigger reported by the server when the error occurred inside one (sourced from the TDS error token's procedure-name field). `None` for direct batch errors.

Cancellation (TDS Attention or our `KILL <spid>` fallback) MUST surface as `AppError::Mssql { code: None, message: "query cancelled", line: None, procedure: None }`. The runner MUST treat this envelope as a cancellation outcome and the result panel MUST render `Cancelled.` instead of the standard error block.

The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "run_sql"`, `kind_namespace: "mssql"`, `connection_id: <id>`, `origin: <origin argument>`, `sql: <full SQL text>`, `params: null`, `metric: { kind: "items", value: <returned-row-count or affected-row-count> }` on success, `metric: null` on failure, and `status` matching the result.

`mssql_run_sql` MUST NOT auto-retry on cancellation — user-issued statements are surfaced as cancelled and the user decides whether to re-run.

#### Scenario: SELECT returns rows envelope

- **WHEN** the user invokes `mssql.runSql(id, "SELECT id, name FROM [dbo].[users] ORDER BY id OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY", "user")`
- **THEN** the response is `{ kind: "rows", columns: [{ name: "id", ... }, { name: "name", ... }], rows: [[...], ...], query_ms, truncated_columns, truncated: false }`
- **AND** one `argus:activity-log` event is emitted with `kind: "run_sql"`, `kind_namespace: "mssql"`, `status: "ok"`, `metric: { kind: "items", value: 5 }`, `origin: "user"`, `sql` containing the SELECT, `params: null`

#### Scenario: sp_help returns rows envelope

- **WHEN** the user invokes `mssql.runSql(id, "EXEC sp_help '[dbo].[users]'", "user")`
- **THEN** the response is `{ kind: "rows", columns: [...], rows: [...], ... }` (first result set from the multi-result `sp_help` output)
- **AND** the activity-log event has `metric: { kind: "items", value: <row count> }`

#### Scenario: INSERT returns affected envelope

- **WHEN** the user invokes `mssql.runSql(id, "INSERT INTO [dbo].[users] (name) VALUES ('a'), ('b'), ('c')", "user")` against a writable connection
- **THEN** the response is `{ kind: "affected", command_tag: "INSERT", affected_rows: 3, query_ms }`
- **AND** the activity-log event has `metric: { kind: "items", value: 3 }`

#### Scenario: DDL returns affected envelope with zero rows

- **WHEN** the user invokes `mssql.runSql(id, "CREATE TABLE [dbo].[foo] ([id] INT)", "user")` against a writable connection
- **THEN** the response is `{ kind: "affected", command_tag: "CREATE TABLE", affected_rows: 0, query_ms }`

#### Scenario: MERGE returns affected envelope

- **WHEN** the user invokes a `MERGE [dbo].[target] USING [dbo].[source] ...` statement against a writable connection
- **THEN** the response is `{ kind: "affected", command_tag: "MERGE", affected_rows: <n>, query_ms }`

#### Scenario: EXEC returns affected envelope

- **WHEN** the user invokes `mssql.runSql(id, "EXEC [dbo].[refresh_view]", "user")` against a writable connection
- **THEN** the response is `{ kind: "affected", command_tag: "EXEC", affected_rows: <n>, query_ms }`

#### Scenario: Mutation on read-only connection rejected before dispatch

- **WHEN** the user invokes `mssql.runSql(id, "DELETE FROM [dbo].[users]", "user")` and the connection has `params.read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }`
- **AND** the SQL is NOT dispatched to MS SQL Server
- **AND** an activity-log event is emitted with `status: "err"`, `error.message` matching the validation message

#### Scenario: SELECT on read-only connection succeeds

- **WHEN** the user invokes `mssql.runSql(id, "SELECT 1", "user")` against a read-only connection
- **THEN** the response is `{ kind: "rows", ... }` with one row
- **AND** no validation error is raised

#### Scenario: Origin defaults to user

- **WHEN** the caller invokes `mssql.runSql(id, "SELECT 1")` without supplying `origin`
- **THEN** the activity-log event has `origin: "user"`

#### Scenario: SQL Server syntax error includes line and code

- **WHEN** the user invokes `mssql.runSql(id, "SELEC 1", "user")` (typo)
- **THEN** the command returns `AppError::Mssql { code: Some(102), message: "Incorrect syntax near 'SELEC'.", line: Some(1), procedure: None }`
- **AND** an activity-log event is emitted with `status: "err"`, `error.code: 102`, `metric: null`

#### Scenario: Invalid object name surfaces 208 with line

- **WHEN** the user invokes `mssql.runSql(id, "SELECT * FROM [dbo].[missing]", "user")`
- **THEN** the command returns `AppError::Mssql { code: Some(208), message: "Invalid object name 'dbo.missing'.", line: Some(1), procedure: None }`

#### Scenario: Read-only database (code 3906) surfaced friendly

- **WHEN** the user issues a mutation against a database marked READ_ONLY at the server level and SQL Server returns error 3906
- **THEN** the command returns `AppError::Mssql { code: Some(3906), message: "connection is read-only: Failed to update database \"X\" because the database is read-only.", line, procedure }`
- **AND** the activity-log event records `error.code: 3906`

#### Scenario: Cancellation surfaces as code None with friendly message

- **WHEN** an in-flight run is cancelled via TDS Attention (or the `KILL <spid>` fallback)
- **THEN** the command returns `AppError::Mssql { code: None, message: "query cancelled", line: None, procedure: None }`
- **AND** the result panel renders `Cancelled.` instead of the standard error block

### Requirement: Run multi-statement command

The MS SQL Server module SHALL expose a Tauri command `mssql_run_sql_many(connection_id, statements, origin?)` that executes a list of pre-split SQL statements sequentially on the **same** pool connection and returns a `{ outcomes: [...] }` payload. The `statements` argument MUST be a `Vec<String>` already split by the frontend (the backend MUST NOT re-split, and MUST NOT process `GO` directives — `GO` is a frontend-side concern). The `origin` argument defaults to `"user"`. The command MUST hold the same connection borrowed from the pool across all statements (so that session-scoped statements like `USE [db]`, `SET ...`, `DECLARE @v ...`, `BEGIN TRAN`, and `SET IDENTITY_INSERT ... ON` persist across the run) and MUST release the connection when the run completes (success, error, or skip).

For each statement the command MUST apply the same classification logic as `mssql_run_sql` (read-only enforcement via `is_mutating_sql`, choice of `mssql_execute_query` vs `mssql_execute_mutation`). The response MUST be `{ outcomes: Array<{ index: number, sql: string, outcome: "ok" | "err" | "skipped", result?: RunSqlResult, error?: { message: string, code: number | null, line: number | null, procedure: string | null } }> }`. On the first statement that returns an error:

- That entry MUST have `outcome: "err"` and the error populated.
- ALL subsequent entries MUST have `outcome: "skipped"` with no `result` and no `error`.

The command MUST NOT wrap the run in an implicit `BEGIN TRAN ... COMMIT`. SQL Server is in implicit-commit (`SET IMPLICIT_TRANSACTIONS OFF`) mode by default and each statement commits on its own unless the user opens an explicit transaction. If the user wants atomicity, they include `BEGIN TRAN` and `COMMIT`/`ROLLBACK` as explicit statements.

The command SHALL emit exactly one `argus:activity-log` event for the entire run, with `kind: "run_sql_many"`, `kind_namespace: "mssql"`, `connection_id: <id>`, `origin: <origin>`, `sql: <statements joined by ";\n">`, `params: null`, `metric: { kind: "items", value: <sum of affected_rows or returned-row-count across all "ok" statements> }` on success, `metric: null` if any statement errored, and `status: "ok"` iff every statement was `"ok"`, `"err"` otherwise.

The total run MUST be bounded by a 30-second wall-clock timeout. Each individual statement MUST be bounded by a 15-second per-statement timeout (raisable per-tab per the "Per-tab timeout selector" requirement). On timeout, the in-flight statement's entry MUST be `outcome: "err"` with `code: None`, `message: "statement timeout"` or `"run timeout"` accordingly, mapped from the cancellation pathway.

`mssql_run_sql_many` MUST NOT auto-retry on cancellation.

#### Scenario: Three successful statements return three outcomes

- **WHEN** the user invokes `mssql.runSqlMany(id, ["SELECT 1", "SELECT 2", "SELECT 3"], "user")`
- **THEN** the response is `{ outcomes: [{ index: 0, sql: "SELECT 1", outcome: "ok", result: { kind: "rows", ... } }, { index: 1, sql: "SELECT 2", outcome: "ok", result: { kind: "rows", ... } }, { index: 2, sql: "SELECT 3", outcome: "ok", result: { kind: "rows", ... } }] }`
- **AND** one `argus:activity-log` event is emitted with `kind: "run_sql_many"`, `kind_namespace: "mssql"`, `status: "ok"`, `metric.value: 3`

#### Scenario: Failure halts execution and skips remaining

- **WHEN** the user invokes `mssql.runSqlMany(id, ["SELECT 1", "SELEC 2", "SELECT 3"], "user")`
- **THEN** the response is `{ outcomes: [{ index: 0, outcome: "ok", result: { kind: "rows", ... } }, { index: 1, outcome: "err", error: { code: 102, ... } }, { index: 2, outcome: "skipped" }] }`
- **AND** the activity-log event has `status: "err"`, `metric: null`

#### Scenario: Session settings persist across statements

- **WHEN** the user invokes `mssql.runSqlMany(id, ["USE [analytics]", "SELECT DB_NAME()"], "user")` against a writable connection
- **THEN** the second statement returns the row `"analytics"` as the current database
- **AND** both entries have `outcome: "ok"`

#### Scenario: Local variable persists across statements within a batch

- **WHEN** the user invokes `mssql.runSqlMany(id, ["DECLARE @x INT = 42; SELECT @x"], "user")` (a single batch containing both statements)
- **THEN** the response has one outcome with `outcome: "ok"`, result rows containing `42`

#### Scenario: BEGIN TRAN / COMMIT persists across statements

- **WHEN** the user invokes `mssql.runSqlMany(id, ["BEGIN TRAN", "INSERT INTO [dbo].[users] (name) VALUES ('x')", "COMMIT"], "user")`
- **THEN** all three entries have `outcome: "ok"`
- **AND** the row is visible on the connection after the run

#### Scenario: Mutation in middle of multi-run on read-only is rejected at that index

- **WHEN** the user invokes `mssql.runSqlMany(id, ["SELECT 1", "DELETE FROM [dbo].[users]", "SELECT 2"], "user")` against a read-only connection
- **THEN** outcome 0 is `"ok"`, outcome 1 is `"err"` with the read-only validation error, outcome 2 is `"skipped"`

#### Scenario: Per-statement timeout aborts long statement

- **WHEN** the user invokes `mssql.runSqlMany(id, ["SELECT 1", "WAITFOR DELAY '00:00:20'", "SELECT 2"], "user")` with the default 15-second per-statement timeout
- **THEN** outcome 0 is `"ok"`, outcome 1 is `"err"` with `error.code: null` and a message containing `"statement timeout"`, outcome 2 is `"skipped"`

#### Scenario: Total run timeout halts the batch

- **WHEN** the user invokes `mssql.runSqlMany(id, [<many statements totalling more than 30s of work>], "user")`
- **THEN** the in-flight statement's outcome is `"err"` with `error.code: null` and message containing `"run timeout"`
- **AND** every statement after it is `"skipped"`

### Requirement: Statement splitting (client-side splitter contract)

The frontend SHALL split the editor document into statements using a MS SQL Server-aware splitter that the backend trusts. The splitter operates in **two levels**:

**Batch level (outer split on `GO`)** — `GO` is a client directive used by SSMS / `sqlcmd` to separate batches. It MUST NOT be sent to the server. The splitter MUST:

- Recognize `GO` (case-insensitive) on its own line with only whitespace before/after the keyword, optionally followed by an integer repeat count (`GO 5` means "execute the preceding batch 5 times").
- Strip `GO` lines from the output. When `GO N` is present (`N > 1`), the splitter MUST emit the preceding batch `N` times in the output statement list, in order.
- NOT treat `GO` as a separator when it appears inside a string literal, identifier bracket, or comment.
- NOT treat tokens like `GOTO`, `GOLDEN`, `GO_FOO` as the `GO` directive — the directive token MUST be exactly `GO` (case-insensitive) with whitespace or end-of-line boundaries.

**Statement level (inner split on `;` within a batch)** — within each batch produced by the outer split, the splitter MUST:

- Recognize single-quoted string literals (`'...'`) with `''` as the escape (SQL Server does not support backslash escapes inside string literals).
- Recognize double-quoted string literals (`"..."`) — under the default `QUOTED_IDENTIFIER ON` mode these are identifiers, not strings; either way the splitter MUST NOT split inside `"..."`.
- Recognize square-bracket-quoted identifiers (`[...]`) with `]]` as the escape for an embedded `]`. Square-bracket identifiers MAY contain semicolons (`[weird;name]`) and the splitter MUST NOT split inside.
- Recognize `--` line comments. Unlike MySQL the splitter MUST NOT require a trailing space after `--` (SQL Server treats `--foo` as a comment).
- Recognize `/* ... */` block comments with **nested** block-comment support — the splitter MUST track nesting depth and only exit the comment when depth returns to zero. (SQL Server supports nested block comments since at least 2005.)
- NOT recognize `#` line comments (MySQL-specific; in SQL Server `#` is part of identifier syntax for temp tables).
- NOT split inside `BEGIN ... END` compound blocks of stored routines.

For v1, the statement-level split is a `;`-based split that respects the lexical rules above and tolerates omission of the trailing `;` at the end of a batch (SSMS-style).

When a batch contains more than one statement and any statement after the first one starts with `CREATE PROCEDURE`, `CREATE FUNCTION`, `CREATE TRIGGER`, or `CREATE VIEW` (case-insensitive, after stripping leading whitespace and comments), the frontend MUST reject the multi-statement run before calling the backend with `AppError::Validation { message: "CREATE PROCEDURE/FUNCTION/TRIGGER/VIEW must be the first statement in its batch; insert a 'GO' separator before it" }`. (These DDL statements must be first in their batch — SQL Server enforces this at parse time, but our splitter catches it client-side with a more actionable error pointing at the missing `GO`.)

The single-statement runner (`mssql_run_sql`) MUST NOT enforce this restriction — running a `CREATE PROCEDURE ... AS BEGIN ... END` body as a single statement against the backend is allowed and the backend MUST pass it through to the server as-is.

#### Scenario: Splitter respects single-quoted strings

- **WHEN** the document is `SELECT 'a;b'; SELECT 1;` and the cursor is in the second statement
- **THEN** the splitter yields exactly two statements (`SELECT 'a;b'` and `SELECT 1`)
- **AND** `Mod-Enter` runs `SELECT 1`

#### Scenario: Splitter respects square-bracket identifiers with semicolons

- **WHEN** the document is `SELECT * FROM [weird;name]; SELECT 1;` (a literal bracket identifier containing a semicolon — pathological but legal in SQL Server)
- **THEN** the splitter yields exactly two statements

#### Scenario: Splitter respects double-quoted identifiers

- **WHEN** the document is `SELECT * FROM "weird;name"; SELECT 1;` (under `QUOTED_IDENTIFIER ON`)
- **THEN** the splitter yields exactly two statements

#### Scenario: Splitter does NOT recognize `#` as a line comment

- **WHEN** the document is `SELECT 1; # not a comment ; SELECT 2;`
- **THEN** the splitter yields three statements (`SELECT 1`, `# not a comment `, `SELECT 2`)
- **AND** the second statement will likely error at the server (which is the expected behavior — `#` is not a SQL Server comment marker)

#### Scenario: Splitter treats `--` without trailing space as a comment

- **WHEN** the document is `SELECT 1--foo\nSELECT 2;`
- **THEN** the splitter yields exactly one batch with two `;`-separated statements: `SELECT 1` (with the `--foo` trailing comment stripped) and `SELECT 2`
- **AND** unlike MySQL the `--foo` is treated as a comment

#### Scenario: Splitter handles nested block comments

- **WHEN** the document is `/* outer /* nested ; */ still in outer */ SELECT 1;`
- **THEN** the splitter yields exactly one statement (`SELECT 1`)
- **AND** the nesting is tracked to depth 2 and back to 0

#### Scenario: Splitter splits on GO at the batch level

- **WHEN** the document is `SELECT 1\nGO\nSELECT 2\nGO`
- **THEN** the splitter yields two batches (`SELECT 1`, `SELECT 2`)
- **AND** the `GO` lines are stripped from the output

#### Scenario: GO is case-insensitive

- **WHEN** the document is `SELECT 1\ngo\nSELECT 2\nGo`
- **THEN** the splitter yields two batches (`SELECT 1`, `SELECT 2`)

#### Scenario: GO with repeat count duplicates the batch

- **WHEN** the document is `INSERT INTO [dbo].[t] (n) VALUES (1)\nGO 3`
- **THEN** the splitter yields three identical batches (the `INSERT` statement three times)

#### Scenario: GO inside a string is not a separator

- **WHEN** the document is `SELECT 'GO\nbar'; SELECT 1`
- **THEN** the splitter yields one batch with two `;`-separated statements
- **AND** no batch split occurs at the literal `GO` inside the string

#### Scenario: GOTO is not treated as GO

- **WHEN** the document is `IF @x = 1 GOTO done;\nSELECT 1;\ndone:\nSELECT 2;`
- **THEN** the splitter yields exactly one batch (no `GO` directive is recognized at `GOTO`)

#### Scenario: GO must be on its own line

- **WHEN** the document is `SELECT 1 GO SELECT 2;` (inline `GO`)
- **THEN** the splitter does NOT split at `GO` (it is not on its own line)
- **AND** the server will reject the resulting SQL with a syntax error — the splitter does not pre-validate

#### Scenario: Trailing batch without GO is included

- **WHEN** the document is `SELECT 1\nGO\nSELECT 2` (no trailing `GO`)
- **THEN** the splitter yields two batches (`SELECT 1`, `SELECT 2`)

#### Scenario: CREATE PROCEDURE not first in batch is rejected client-side

- **WHEN** the user presses `Mod-Shift-Enter` on a buffer `SELECT 1; CREATE PROCEDURE p AS SELECT 1;` (no `GO` between the two)
- **THEN** the frontend surfaces a validation error `CREATE PROCEDURE/FUNCTION/TRIGGER/VIEW must be the first statement in its batch; insert a 'GO' separator before it`
- **AND** no Tauri call is made

#### Scenario: CREATE FUNCTION first in batch with preceding GO is accepted

- **WHEN** the user presses `Mod-Shift-Enter` on a buffer `SELECT 1\nGO\nCREATE FUNCTION f() RETURNS INT AS BEGIN RETURN 1 END\nGO`
- **THEN** the splitter yields two batches and both are dispatched

#### Scenario: CREATE PROCEDURE accepted as a single statement run

- **WHEN** the user selects the entire `CREATE PROCEDURE p AS BEGIN SELECT 1; SELECT 2 END` body and presses `Mod-Enter`
- **THEN** `mssql_run_sql` is invoked with the full body as a single `sql` argument
- **AND** the backend dispatches it to the server unchanged

### Requirement: Result row cap

`mssql_run_sql` and each step of `mssql_run_sql_many` SHALL cap the returned row set at 10,000 rows. When a query produces more than 10,000 rows, the backend MUST return the first 10,000 in `rows`, MUST set `truncated: true` in the response, and MUST stop fetching further rows from the server (drop the tiberius row stream / send Attention to cancel further fetches). The cap is per-statement, not per-run. The `query_ms` MUST measure end-to-end including the time spent fetching the cap-many rows.

#### Scenario: Query returning under cap is not truncated

- **WHEN** a SELECT returns 4,200 rows
- **THEN** the response has `rows.length === 4200` and `truncated: false`

#### Scenario: Query exceeding cap is truncated to 10,000 with marker

- **WHEN** a SELECT against a 1M-row table runs without TOP / OFFSET ... FETCH
- **THEN** the response has `rows.length === 10000` and `truncated: true`
- **AND** the activity-log event metric is `{ kind: "items", value: 10000 }`

### Requirement: Query tab kind

The frontend SHALL register a tab kind `mssql-query` and SHALL render it in the center work area when the user activates a "New Query" entry point (sidebar button, palette command, double-click on a saved query). The tab payload MUST be `{ connection_id?: string, connection_name?: string, sql: string, saved_query_id?: string }`. The tab MUST have an id of the form `mssqlquery:<uuid>` where `<uuid>` is a fresh v4 UUID generated on tab creation; the id MUST NOT embed the connection id (the connection is mutable in runtime — see "Connection selector in editor toolbar").

The current connection of a tab MUST live in per-tab state (`useMssqlQueryTabState`), not in the tab payload or in the tab id. When the tab is created, the current connection is initialized from `connection_id` (or from the most recently-used connection of the saved query if `saved_query_id` is provided and the persisted `last_connection_id` references an existing MS SQL Server connection), or unset if neither is available.

The default tab title MUST be:

- The saved query's `name` when `saved_query_id` is provided.
- `Query <N>` otherwise, where `N` is a global running counter (shared across dialects) starting at 1. The counter resets when the app launches.

Activating "New Query" with no `saved_query_id` MUST always create a new tab (never focus an existing one). Activating "Open" on a saved query whose `saved_query_id` matches an already-open tab MUST focus the existing tab instead of creating a new one. The "Open in new tab" action on a saved query MUST always create a new tab.

#### Scenario: New Query opens a fresh tab without a saved query binding

- **WHEN** the user clicks `+ Query` from the MS SQL Server sidebar
- **THEN** a center-area tab of kind `mssql-query` opens with payload `{ connection_id: <current focused connection or undefined>, sql: "", saved_query_id: undefined }` and id `mssqlquery:<uuid>`
- **AND** the tab title is `Query <N>` for the next global counter value

#### Scenario: Opening a saved query reuses existing tab

- **WHEN** a `mssql-query` tab already exists with `state.saved_query_id === "abc"`
- **AND** the user double-clicks the saved query `abc` in the sidebar tree
- **THEN** the existing tab is focused (no new tab created)

#### Scenario: Opening a saved query in a new tab forces creation

- **WHEN** a `mssql-query` tab already exists with `state.saved_query_id === "abc"`
- **AND** the user selects `Open in new tab` from the context menu on saved query `abc`
- **THEN** a second `mssql-query` tab is created with `state.saved_query_id === "abc"` and a fresh `mssqlquery:<uuid>` id
- **AND** both tabs coexist in the tab strip

#### Scenario: Saved query restores last_connection_id when present

- **WHEN** the user opens saved query `abc` and its persisted `last_connection_id` is `conn-prod` which is a currently registered MS SQL Server connection
- **THEN** the new tab's current connection is set to `conn-prod` and the editor toolbar's connection selector reflects this

#### Scenario: Saved query without a valid last connection opens with selector empty

- **WHEN** the user opens a saved query whose `last_connection_id` is null OR references a connection that no longer exists in the registry
- **THEN** the tab opens with no current connection and the editor toolbar's selector shows a placeholder prompting selection

### Requirement: CodeMirror editor with MS SQL Server dialect

Each `mssql-query` tab SHALL render a CodeMirror 6 editor with `@codemirror/lang-sql` configured with the `MSSQL` dialect. The editor MUST use `Geist Mono` per `DESIGN.md`, render with the app's current theme tokens (`var(--surface)` background, `var(--border)` for the gutter divider, `var(--accent)` for selection), and mount directly via `EditorView` on a `ref`'d `<div>` (no React wrapper around CodeMirror). The editor MUST provide line numbers, syntax highlighting for SQL keywords/strings/comments, bracket matching, multi-cursor support (Mod-D), comment-line toggle (Mod-/), and indentation via Tab / Shift-Tab. The editor MUST take focus on tab open.

The Tab key SHALL behave context-sensitively:

- When the autocomplete popup is open with an active suggestion (`completionStatus(state) === "active"`), Tab MUST accept the highlighted suggestion (equivalent to `acceptCompletion`).
- Otherwise, Tab MUST insert one indent level (`indentMore`).

Shift-Tab MUST always dedent (`indentLess`), regardless of popup state.

The comment-line toggle MUST use `-- ` (with trailing space) so that toggling produces parseable comments.

#### Scenario: Editor mounts with empty SQL on new tab

- **WHEN** the user opens a `mssql-query` tab for the first time
- **THEN** an empty editor is rendered with focus, line number 1 visible, and the gutter using `var(--border)`

#### Scenario: SQL syntax highlighting is active

- **WHEN** the user types `SELECT id FROM [dbo].[users] WHERE id = 1`
- **THEN** `SELECT`, `FROM`, `WHERE` are highlighted as keywords
- **AND** `1` is highlighted as a numeric literal

#### Scenario: Square-bracket identifier is highlighted

- **WHEN** the user types `SELECT [id] FROM [users]`
- **THEN** the bracket-delimited tokens are highlighted as identifiers (not strings)

#### Scenario: Comment toggle inserts `-- ` with trailing space

- **WHEN** the user selects two lines of SQL and presses `Mod-/`
- **THEN** both lines gain a leading `-- ` (with the required trailing space)
- **AND** pressing `Mod-/` again removes the prefix

#### Scenario: Tab accepts the active autocomplete suggestion

- **WHEN** the user types `SEL` and the autocomplete popup is showing `SELECT` as the highlighted suggestion
- **AND** the user presses Tab
- **THEN** the editor inserts `SELECT` (replacing the partial `SEL`) and closes the popup
- **AND** no Tab indent is applied

#### Scenario: Tab indents when no popup is active

- **WHEN** the editor has no autocomplete popup visible
- **AND** the cursor is at the start of a line
- **AND** the user presses Tab
- **THEN** the editor inserts one indent level at the cursor

#### Scenario: Shift-Tab always dedents

- **WHEN** the cursor is on a line indented with two levels and the autocomplete popup is open OR closed
- **AND** the user presses Shift-Tab
- **THEN** the editor removes one indent level from the current line
- **AND** the popup state is unchanged

### Requirement: Run shortcut and statement-under-cursor detection

The editor SHALL bind `Mod-Enter` to "run" the SQL with **highest precedence** (`Prec.highest` in CodeMirror terms) so that no other extension's keymap can intercept it. When invoked:

- If the editor has a non-empty selection, it MUST run **only** the selected text as the SQL.
- Otherwise it MUST run the **statement under the cursor**, where the statement is determined by splitting the editor's full document with the MS SQL Server-aware splitter defined in "Statement splitting (client-side splitter contract)" at the statement level (treating `GO` boundaries as hard separators between batches and only considering `;`-separated statements within the cursor's batch). The cursor's offset MUST be matched against the statement ranges; if the cursor sits in whitespace between two statements (or on a `GO` line itself), the editor MUST run the immediately preceding statement.
- If the cursor is in the document body and no statements exist (e.g. only whitespace, comments, and `GO` lines), the editor MUST surface a non-blocking toast `Nothing to run.` and MUST NOT invoke the backend.

The editor SHALL also bind `Mod-Shift-Enter` to "run all" — execute every statement in the document as a multi-statement run, regardless of cursor or selection — also at `Prec.highest`. Run-all MUST feed the splitter's full batch+statement output into `mssql_run_sql_many` (with `GO` directives already stripped and batch repeat counts already expanded).

When a single statement is to be executed, the frontend MUST invoke `mssql_run_sql`. When two or more statements are to be executed (only via run-all), the frontend MUST invoke `mssql_run_sql_many` with the array produced by the splitter.

This editor MUST NOT bind itself to nor accept user-supplied `@P1` placeholder values: the user writes literal SQL and runs it as-is. The MS SQL Server `@P1, @P2, ...` placeholder syntax is recognized only as a lexical token (highlighted as a variable, not as a binding hole) — the editor does not prompt for parameter values.

#### Scenario: Run with selection sends only the selection

- **WHEN** the user has the document `SELECT 1; SELECT 2;` and selects exactly `SELECT 2`, then presses `Mod-Enter`
- **THEN** `mssql_run_sql` is invoked with `sql: "SELECT 2"`

#### Scenario: Run without selection picks statement under cursor

- **WHEN** the document is `SELECT 1;\nSELECT 2;\nSELECT 3;` with the cursor on line 2
- **AND** the user presses `Mod-Enter`
- **THEN** `mssql_run_sql` is invoked with `sql: "SELECT 2"`

#### Scenario: Splitter ignores semicolons inside strings

- **WHEN** the document is `SELECT 'a;b'; SELECT 1;` and the cursor is in the second statement
- **THEN** the splitter yields exactly two statements (`SELECT 'a;b'` and `SELECT 1`)
- **AND** `Mod-Enter` runs `SELECT 1`

#### Scenario: Run all invokes run_sql_many with GO directives stripped

- **WHEN** the document has `SELECT 1\nGO\nSELECT 2;\nSELECT 3;\nGO` and the user presses `Mod-Shift-Enter`
- **THEN** `mssql_run_sql_many` is invoked with the array `["SELECT 1", "SELECT 2", "SELECT 3"]` (`GO` directives stripped, in document order)

#### Scenario: Run all expands GO repeat counts

- **WHEN** the document has `INSERT INTO [dbo].[t] (n) VALUES (1)\nGO 3` and the user presses `Mod-Shift-Enter`
- **THEN** `mssql_run_sql_many` is invoked with the array containing the INSERT statement three times

#### Scenario: Cursor in whitespace runs preceding statement

- **WHEN** the document is `SELECT 1;\n\nSELECT 2;` with the cursor on the empty line between them
- **AND** the user presses `Mod-Enter`
- **THEN** `mssql_run_sql` is invoked with `sql: "SELECT 1"`

#### Scenario: Cursor on a GO line runs the preceding batch

- **WHEN** the document is `SELECT 1\nGO\nSELECT 2` with the cursor on the `GO` line
- **AND** the user presses `Mod-Enter`
- **THEN** `mssql_run_sql` is invoked with `sql: "SELECT 1"`

#### Scenario: Mod-Enter wins over default keymap

- **WHEN** the editor is focused and the user presses `Mod-Enter`
- **THEN** the run handler fires exactly once
- **AND** the editor's document is NOT modified (no newline is inserted by any default `Enter`-family binding)

#### Scenario: Literal `@P1` placeholder is preserved verbatim

- **WHEN** the user types `SELECT * FROM [dbo].[users] WHERE id = @P1` and presses `Mod-Enter`
- **THEN** the SQL sent to `mssql_run_sql` contains the literal `@P1` token unchanged
- **AND** the editor does NOT prompt for a parameter value (the server will reject the unbound `@P1` with its own error, which the editor surfaces normally)

### Requirement: Schema-aware autocomplete from in-memory cache

The editor SHALL offer autocomplete suggestions from **three composed sources** running in parallel inside a single `autocompletion({ override: [...] })` extension:

1. **Keyword source** — `keywordCompletionSource(MSSQL, /*upperCase=*/ true)` from `@codemirror/lang-sql`. Always available; suggests reserved words and built-in functions of the MS SQL Server dialect. The MS SQL Server keyword set MUST include MS SQL Server-specific constructs such as `TOP`, `OFFSET`, `FETCH NEXT`, `ROWS ONLY`, `OUTPUT`, `MERGE`, `OVER`, `PARTITION BY`, `WITH (NOLOCK)`, `TABLOCK`, `IDENTITY_INSERT`, `SCOPE_IDENTITY`, `NEWID`, `NEWSEQUENTIALID`, `OBJECT_DEFINITION`, `OPENROWSET`, `OPENJSON`, `STRING_AGG`, `CROSS APPLY`, `OUTER APPLY`, `GO`, `EXEC`, `EXECUTE`, `DECLARE`, `BEGIN TRAN`, `COMMIT`, `ROLLBACK`, `RAISERROR`, `THROW`, `TRY ... CATCH`.

2. **Schema source** — `schemaCompletionSource({ dialect: MSSQL, schema: namespace })` from `@codemirror/lang-sql`, where `namespace` is built from `mssqlSchemaCache.getNamespace(connection_id)`. This source MUST canonically handle:
   - Qualified names (`<schema>.<partial>` and `<database>.<schema>.<partial>`) by anchoring `from` immediately after the last dot and filtering only the partial — no greedy capture of the schema/database portion.
   - Default-schema unqualified table completion (when the active connection's default schema is known — typically `dbo`).
   - FROM-clause aware column scoping: when the editor's parse tree shows `SELECT ... FROM [dbo].[users] u`, completing `u.` MUST suggest only the columns of `dbo.users` (sourced from `mssql-columns-cache`).
   - CTE awareness: tables declared in `WITH name AS (...)` MUST be available as completions in the body of the same statement.

3. **Document identifier source** — a custom source that walks the editor's syntax tree (via `syntaxTree(state)` from `@codemirror/language`) and extracts:
   - CTE names declared in `WITH ... AS (...)` clauses.
   - Aliases declared in `FROM <table> [AS] <alias>` and `JOIN <table> [AS] <alias>` clauses.
   - Local variable names declared via `DECLARE @var <type>` (so subsequent uses of `@var` complete).
   - Other identifiers that appear in `FromClause` / `JoinClause` positions.
   This source MUST NOT use raw regex to identify these tokens — it MUST use the parser's syntax tree so that strings, comments, and bracket identifiers are correctly excluded.

The schema source's column suggestions MUST consume the `mssql-columns-cache` (specified in a sibling capability) — when a relation's columns are not yet cached, the source MUST trigger a fetch via the cache's normal lazy-load contract and offer keyword-only / document-only completions until the cache resolves.

The editor MUST keep the `sql({ dialect: MSSQL })` language configuration in a separate `Compartment` from `autocompletion`, so that reconfiguring the autocomplete sources (when the schema cache changes) does NOT re-instantiate the language or invalidate the syntax tree / highlighting / indent logic.

When `mssqlSchemaCache` notifies of a change, the editor MUST reconfigure the autocomplete `Compartment` to re-bind `schemaCompletionSource` to the new namespace, debounced 100ms. If the new namespace is shape-equal to the previous (same schema names with same relation name sets), the reconfigure MUST be skipped to avoid editor churn.

When neither schemas, relations, nor columns are loaded for the current connection, the editor MUST still function and offer **keyword-only completion** plus document identifiers found in the current buffer.

#### Scenario: Keywords always complete

- **WHEN** the editor is empty and the user types `SEL`
- **THEN** the autocomplete popup opens with `SELECT` as a top suggestion
- **AND** the suggestion has type `keyword`

#### Scenario: MS SQL Server-specific keywords are available

- **WHEN** the editor contains `SELECT TOP 10 * FROM [dbo].[t] WHERE id IN (SELECT id FROM [dbo].[u] WITH (NO`
- **THEN** the autocomplete popup includes `NOLOCK` as a suggestion

#### Scenario: Qualified name completion is canonical

- **WHEN** the schema cache contains `dbo.users`, `dbo.orders`, `sales.invoices`
- **AND** the user types `SELECT * FROM dbo.us`
- **THEN** the autocomplete popup shows `users` (and any other `dbo.*` relations matching `us`) as the top suggestion
- **AND** the popup does NOT consume the `dbo.` portion as part of the typed prefix — only `us` is the partial

#### Scenario: Three-part qualified name completion

- **WHEN** the user types `SELECT * FROM mydb.dbo.us`
- **THEN** the autocomplete popup shows `users` (the database segment is recognized but only the partial `us` is the typed prefix)

#### Scenario: Alias-aware column completion via columns cache

- **WHEN** the document is `SELECT u. FROM [dbo].[users] u` with the cursor right after `u.`
- **AND** `mssql-columns-cache` has columns for `dbo.users`
- **THEN** the autocomplete popup suggests every column of `dbo.users` (e.g. `id`, `email`, `created_at`)
- **AND** does NOT suggest columns of unrelated relations

#### Scenario: CTE name appears in completion

- **WHEN** the document is `WITH recent AS (SELECT * FROM [dbo].[events]) SELECT * FROM rec`
- **AND** the cursor is right after `rec`
- **THEN** the autocomplete popup includes `recent` as a suggestion (sourced from the document identifier source)
- **AND** the suggestion's `detail` indicates it is a CTE

#### Scenario: DECLARE-introduced variable completes

- **WHEN** the document is `DECLARE @customer_id INT = 1;\nSELECT * FROM [dbo].[orders] WHERE customer_id = @cust`
- **AND** the cursor is right after `@cust`
- **THEN** the autocomplete popup includes `@customer_id` as a suggestion

#### Scenario: Cache update reconfigures autocomplete without breaking the editor

- **WHEN** a new schema `sales` is bulk-loaded into the cache while a query tab is open
- **THEN** within ~100ms the editor's autocomplete reflects the new schema (typing `FROM sales.` shows its relations)
- **AND** the editor's syntax highlighting, current selection, undo history, and any in-flight popup state are NOT disrupted

#### Scenario: Empty cache falls back gracefully

- **WHEN** the connection has just been activated and no schemas or columns are cached yet
- **AND** the user types `SEL`
- **THEN** the autocomplete popup shows `SELECT` (keyword source)
- **AND** does NOT throw or error

#### Scenario: Same-shape namespace skips reconfigure

- **WHEN** the cache notifies of a change but the resulting namespace has the same schemas and the same relations per schema as the previous reconfigure
- **THEN** the editor does NOT dispatch a reconfigure effect
- **AND** the autocomplete state is unchanged

### Requirement: Result panel for rows and affected outcomes

Each `mssql-query` tab SHALL render a result panel below the editor. The panel MUST:

- Render a hint state when no run has occurred yet in this tab. The hint MUST advertise both run and autocomplete shortcuts so the user discovers them on first use; the recommended copy is `Press ⌘↩ to run · Tab to autocomplete`.
- Render a virtualized read-only data grid (the `<MssqlAdhocResultGrid />` provided by `mssql-data-grid`) for `kind: "rows"` results, displaying the `columns` and `rows` from the response. The grid MUST support row selection that drives the shell's right inspector (when the inspector is expanded). Column widths inside the grid MUST default to the type-derived base widths defined by `column-width-preferences` and MUST be user-resizable; resizing MUST NOT persist to disk across runs or sessions, but MUST persist within the same `<MssqlAdhocResultGrid />` instance for as long as the columns prop shape is unchanged.
- Render a compact summary line for `kind: "affected"` results: `<command_tag> · <affected_rows> rows affected · <query_ms> ms`. Example: `INSERT · 3 rows affected · 12 ms`.
- Display a banner above the grid `Result truncated at 10,000 rows — add a TOP / OFFSET ... FETCH NEXT clause to refine.` whenever the response has `truncated: true`.

The panel's height MUST be resizable via a drag handle on its top edge (between editor and panel) within bounds 120–800px; the height MUST persist per tab id under settings key `mssqlQueryResultHeight:<tab_id>` while the tab exists.

#### Scenario: Empty state on fresh tab advertises run + autocomplete

- **WHEN** a `mssql-query` tab is opened and no run has been executed
- **THEN** the panel shows the hint `Press ⌘↩ to run · Tab to autocomplete`
- **AND** no grid is rendered

#### Scenario: Rows result renders the adhoc grid

- **WHEN** a SELECT returns 50 rows with 4 columns
- **THEN** the panel renders a `<MssqlAdhocResultGrid />` with those 50 rows and 4 columns
- **AND** clicking a row populates the shell's right inspector with that row's column-value list

#### Scenario: Affected result renders the compact summary

- **WHEN** an INSERT returns `{ kind: "affected", command_tag: "INSERT", affected_rows: 3, query_ms: 12 }`
- **THEN** the panel shows `INSERT · 3 rows affected · 12 ms`
- **AND** no grid is rendered

#### Scenario: Truncation banner surfaces above the grid

- **WHEN** a SELECT returns 10,000 rows with `truncated: true`
- **THEN** a banner reads `Result truncated at 10,000 rows — add a TOP / OFFSET ... FETCH NEXT clause to refine.` above the grid

#### Scenario: Adhoc grid column widths reset when columns prop changes

- **WHEN** the user runs `SELECT id, email FROM [dbo].[users]`, resizes `email` to 320px, then runs `SELECT id, email, status FROM [dbo].[users]` in the same tab
- **THEN** the new result re-renders the grid with `id`, `email`, and `status` at their type-derived base widths
- **AND** the previous 320px override for `email` is discarded

### Requirement: Error block with SQL Server code and line

When a run results in `AppError::Mssql { code, message, line, procedure }` or `AppError::Validation { message }`, the result panel MUST render an error block in `var(--danger)` that displays:

- The error message verbatim, with `connection is read-only` prepended (followed by `: `) when the underlying server error code is `3906` or `3908` (read-only database / replica).
- The SQL Server error number in monospace (when `code` is present) — rendered as e.g. `Error 208`.
- The procedure name on its own line `In procedure: <procedure>` when `procedure` is present.
- An inline `Show in editor` button when `line` is present; activating it MUST move the editor's cursor to the start of `line` (1-based; CodeMirror lines are 1-based) within the most recently executed SQL and place a red wavy underline decoration across the entire line.

The renderer MUST display the line for the user (`Line N`). When the server reports `line` and the source SQL the user actually ran (the selected text, the statement under cursor, or the full document for run-all) has fewer lines than `line`, the renderer MUST clamp to the last line of the source.

For multi-statement runs, the failing statement's index MUST be shown as `Statement <i>` (1-based) and clicking `Show in editor` MUST move the cursor to `statement.start_line + line - 1` so the cursor lands at the actual error location in the source document. The red underline decoration MUST be placed on that line in the source document, not in the (now hidden) failing statement substring.

The error decoration MUST clear as soon as the user types anywhere in the editor.

The error block MUST NOT render character-precision underlines — SQL Server only reports line numbers, not character offsets within a line. The decoration is a whole-line underline.

#### Scenario: Single-statement syntax error renders inline error

- **WHEN** the user runs `SELEC 1`
- **THEN** the panel renders an error block with the server message, `Error 102`, `Line 1`, and a `Show in editor` button
- **AND** activating `Show in editor` moves the cursor to the start of line 1

#### Scenario: Invalid object name renders with code 208

- **WHEN** the user runs `SELECT * FROM [dbo].[missing]`
- **THEN** the panel renders the verbatim server message, `Error 208`, and `Line 1`

#### Scenario: Error inside a stored procedure shows procedure name

- **WHEN** the user runs `EXEC [dbo].[broken_proc]` and the error occurs at line 5 of the procedure body
- **THEN** the panel renders `Error <n>`, `In procedure: dbo.broken_proc`, `Line 5`

#### Scenario: Multi-statement failing index is labeled and shows in editor

- **WHEN** a run-many produces `[ok, err, skipped]`, the failing entry has `index: 1`, `line: 2`, and the second statement starts at line 4 in the source document
- **THEN** the panel renders the error block prefixed with `Statement 2`
- **AND** the `Show in editor` button moves the cursor to the start of source line `4 + 2 - 1 = 5`
- **AND** the red underline is placed on that line

#### Scenario: Read-only database error 3906 prepends friendly message

- **WHEN** a run fails with `AppError::Mssql { code: Some(3906), message: "Failed to update database 'X' because the database is read-only.", line: Some(1), procedure: None }`
- **THEN** the error block's first line reads `connection is read-only: Failed to update database 'X' because the database is read-only.`
- **AND** `Error 3906` is shown in monospace beneath the message

#### Scenario: Cancellation renders as Cancelled, not an error block

- **WHEN** a run completes with `AppError::Mssql { code: None, message: "query cancelled", ... }`
- **THEN** the panel renders the message `Cancelled.` instead of the standard error block
- **AND** no `Show in editor` button is rendered

### Requirement: Multi-statement result sub-tabs

When a run returns more than one statement outcome (i.e. `mssql_run_sql_many` was invoked), the result panel MUST render sub-tabs (one per statement) in document order. Each sub-tab's label MUST follow the pattern `<i> · <summary>` where `<i>` is the 1-based statement index and `<summary>` is:

- `<row_count> rows` for `kind: "rows"`.
- The `command_tag` for `kind: "affected"` (e.g. `INSERT`, `UPDATE`, `CREATE TABLE`, `MERGE`, `EXEC`).
- `✗ <code or "error">` for `outcome: "err"`.
- `… skipped` for `outcome: "skipped"`.

The first sub-tab MUST be selected by default, EXCEPT when one or more statements failed — in that case the first failed sub-tab MUST be selected automatically. The sub-tab content MUST render the same components as the single-statement panel (grid, summary, or error block).

#### Scenario: Three successes show three sub-tabs

- **WHEN** a run-many produces `[{ rows: 5 }, { rows: 12 }, { affected: "UPDATE" with 3 rows }]`
- **THEN** the panel renders three sub-tabs labeled `1 · 5 rows`, `2 · 12 rows`, `3 · UPDATE`
- **AND** sub-tab 1 is selected by default

#### Scenario: First failure auto-focuses

- **WHEN** a run-many produces `[ok, err, skipped]`
- **THEN** sub-tab 2 is selected automatically and shows the error block

#### Scenario: Skipped sub-tab shows hint

- **WHEN** the user clicks a `… skipped` sub-tab
- **THEN** the sub-tab content reads `Skipped because an earlier statement failed.`

#### Scenario: GO-expanded repeats render as separate sub-tabs

- **WHEN** the user runs `INSERT INTO [dbo].[t] (n) VALUES (1)\nGO 3` via `Mod-Shift-Enter`
- **THEN** the panel renders three sub-tabs labeled `1 · INSERT`, `2 · INSERT`, `3 · INSERT`

### Requirement: Bottom status indicator

Each `mssql-query` tab SHALL display a status indicator inside the tab's chrome (between editor and result panel, or in the panel header). The indicator MUST show: the latest run's elapsed time (`12 ms`) and the latest run's outcome summary (`5 rows`, `3 rows affected`, or `error`). When a run is in flight, the indicator MUST show the live elapsed-time text per the "Live elapsed-time indicator while running" requirement (i.e. `Running…` for the first second, then `Running… <s>s` up to a minute, then `Running… <m>:<ss>` past one minute).

#### Scenario: Indicator updates after a successful run

- **WHEN** a SELECT completes returning 5 rows in 12 ms
- **THEN** the indicator reads `5 rows · 12 ms`

#### Scenario: Indicator shows running state with live elapsed time

- **WHEN** a run has been in flight for 2300ms and the response has not yet arrived
- **THEN** the indicator reads `Running… 2.3s`
- **AND** the text continues to tick approximately every 100ms until the run completes

### Requirement: In-session SQL buffer persistence

Each `mssql-query` tab SHALL persist its SQL document under settings key `mssqlQueryBuffer:<tab_id>` with a debounce of 500ms after the last keystroke. On tab mount, the editor MUST read this key and initialize its document from it (or from the tab payload's `sql` field if no setting exists). When the tab closes, the key MUST be removed. The shell does not currently restore tabs across app launches; this requirement only ensures the buffer survives focus changes and refreshes within a single session.

#### Scenario: Buffer survives switching tabs and returning

- **WHEN** the user types `SELECT 42` in a query tab, switches to another tab, and returns to the query tab
- **THEN** the editor still shows `SELECT 42`

#### Scenario: Closing the tab removes the buffer

- **WHEN** the user types into a query tab and then closes it
- **THEN** the settings key `mssqlQueryBuffer:<tab_id>` no longer exists

### Requirement: Read-only banner above the editor

When the active connection has `params.read_only: true`, each `mssql-query` tab against that connection MUST render a banner above the editor reading `Read-only connection — non-SELECT statements will be rejected.` The banner MUST use `var(--accent-soft)` background and an icon. The editor and result panel MUST otherwise function normally (SELECTs run, `sp_help` runs, `SET SHOWPLAN_TEXT` runs); only mutations are rejected by the backend.

#### Scenario: Banner appears on read-only connection

- **WHEN** the user opens a query tab against a read-only connection
- **THEN** the banner is visible above the editor

#### Scenario: SELECT still runs on read-only connection

- **WHEN** the user runs `SELECT 1` on the read-only tab
- **THEN** the result panel renders the row normally with no error

### Requirement: Tab close discards buffer without confirm

Closing a `mssql-query` tab via `Mod-W` or the tab's close button MUST close the tab immediately and remove its `mssqlQueryBuffer:<tab_id>` setting. No confirmation dialog MUST be shown, even if the document is non-empty (the dirty-state confirmation in "Dirty state tracking and unsaved-changes confirmation" applies only to tabs bound to a saved query). Rationale: SQL in the editor is not yet committed to the database; losing it is not as costly as losing a dirty edit buffer.

#### Scenario: Close drops the buffer with no prompt

- **WHEN** the user has typed `SELECT 1` and presses `Mod-W` on the query tab (with no `saved_query_id`)
- **THEN** the tab closes immediately
- **AND** no confirmation dialog appears
- **AND** the `mssqlQueryBuffer:<tab_id>` key is removed

### Requirement: Prefilled SQL survives StrictMode mount race

When a `mssql-query` tab opens with a non-empty `payload.sql` (for example, via the data viewer's `Open in SQL Editor` action), the editor MUST mount with `payload.sql` as its initial document, on every code path — including under React 18 `<React.StrictMode>` dev double-mount.

The in-session SQL buffer cleanup ("closing a tab discards the buffer") MUST be tied to the actual tab-close gesture (the close-handler registry consulted by `TabStrip`), NOT to React unmount alone. A StrictMode replay (mount → cleanup → mount on the same tab) MUST NOT clobber the buffer with the empty string between the first mount's seeding and the second mount's read.

#### Scenario: Open in SQL Editor lands on the prefilled SQL in dev

- **WHEN** the user clicks `Open in SQL Editor` from a MS SQL Server table viewer that has a non-empty applied filter
- **AND** the app is running with `<React.StrictMode>` enabled (dev mode)
- **THEN** the new query tab's editor mounts with the SQL produced by `compileMssqlPrefilledSelect` (`SELECT * FROM [schema].[table] WHERE ... ORDER BY [pk] OFFSET 0 ROWS FETCH NEXT N ROWS ONLY`) as its initial document
- **AND** the editor never displays an empty document for the lifetime of the tab

#### Scenario: Open in SQL Editor lands on the prefilled SQL in prod

- **WHEN** the user clicks `Open in SQL Editor` in production (no StrictMode replay)
- **THEN** the editor mounts with the same `compileMssqlPrefilledSelect` output

#### Scenario: Closing a query tab still removes the buffer

- **WHEN** the user closes a `mssql-query` tab via the close button or `Mod-W`
- **THEN** the `mssqlQueryBuffer:<tab_id>` settings key is removed
- **AND** no confirmation dialog is shown (when the tab has no saved-query binding)

### Requirement: Run commands persist a query-history row per executed statement

In the SAME execution path where `mssql_run_sql` emits its `argus:activity-log` event AND for each successfully-executed step of `mssql_run_sql_many` (one history row per executed step, plus one row for the first errored step in a multi-run), the platform MUST persist a row to the `query_history` SQLite table per the `query-history` capability — exactly one row per executed statement. This includes failed statements (`status: "err"`) and excludes statements that were skipped because an earlier statement failed in a multi-run.

The persistence MUST happen before the run command returns to the frontend, MUST run on the same Tauri command thread (no async task spawn), and MUST NOT mask the SQL execution outcome: any error from the `query_history` insert MUST be logged to stderr but MUST NOT propagate as the command's response. The user-visible behavior of `mssql_run_sql` and `mssql_run_sql_many` (return shape, activity-log events, read-only enforcement, row cap, timeouts) is otherwise unchanged.

The persisted row's fields are owned by the `query-history` capability spec; this requirement only fixes the trigger point, the dialect tag (`mssql`), and the 1:1 correspondence with executed statements. Each history row MUST carry `(connection_id, dialect: "mssql", sql, ran_at, status, duration_ms, error_code?, error_message?, origin)` where `error_code` is the stringified numeric SQL Server error number (or `null` for transport/cancellation errors).

#### Scenario: Each successful run produces one history row

- **WHEN** the user invokes `mssql.runSql(id, "SELECT 1", "user")` against a writable connection
- **THEN** the count of `query_history` rows increases by exactly 1
- **AND** that row's `sql` is `"SELECT 1"`, `status` is `"ok"`, `origin` is `"user"`, `dialect` is `"mssql"`

#### Scenario: Each failed run still produces one history row

- **WHEN** the user invokes `mssql.runSql(id, "SELEC 1", "user")` and SQL Server returns error 102
- **THEN** the count of `query_history` rows increases by exactly 1
- **AND** that row has `status: "err"`, `error_code: "102"`, `dialect: "mssql"`

#### Scenario: Run-many writes one row per executed step, none for skipped

- **WHEN** the user invokes `mssql.runSqlMany(id, ["SELECT 1", "SELEC 2", "SELECT 3"], "user")`
- **THEN** the count of `query_history` rows increases by exactly 2 (one ok, one err)
- **AND** no row is written for the third (skipped) statement

#### Scenario: Run-many with all successes writes one row per statement

- **WHEN** the user invokes `mssql.runSqlMany(id, ["SELECT 1", "SELECT 2", "SELECT 3"], "user")`
- **THEN** the count of `query_history` rows increases by exactly 3, each with `status: "ok"` and `dialect: "mssql"`

#### Scenario: A failure to persist history does not fail the run

- **WHEN** the SQL execution succeeds but the subsequent `query_history` insert fails (for example, SQLite is locked)
- **THEN** the run command still returns the successful `RunSqlResult` to the frontend
- **AND** an error is logged to stderr describing the persistence failure

#### Scenario: Cancellation history row has null error_code

- **WHEN** the user cancels a long-running query and the run returns `AppError::Mssql { code: None, message: "query cancelled", ... }`
- **THEN** a history row is written with `status: "err"`, `error_code: null`, `error_message: "query cancelled"`

### Requirement: MS SQL Server message surfaces verbatim in error envelope

When the backend converts a `tiberius::error::Error` (or its bb8-tiberius wrapper) into `AppError::Mssql`, the `MssqlErrorBody.message` field MUST carry the **SQL-Server-supplied** error message — not the driver's top-level `Display` string. Specifically:

- When the driver reports a server error with a numeric `code` (`number` field on the TDS error token) and a `message` payload, the `message` field MUST be the server's message string verbatim (e.g. `"Invalid object name 'dbo.missing'."`).
- The `code` field MUST be the numeric SQL Server error number (e.g. `208`, `102`, `2627`) as an `i32`.
- The `line` field MUST be the 1-based line number reported by the TDS error token, when present. `None` otherwise.
- The `procedure` field MUST be the procedure name reported by the TDS error token, when the error occurred inside a stored procedure or trigger. `None` for direct batch errors.
- When the driver reports a transport, protocol, TLS, or I/O error with no server-side payload, the `message` field MUST fall back to the driver error's `Display` string, `code` MUST be `None`, `line` MUST be `None`, `procedure` MUST be `None`.
- When the driver signals cancellation (`tiberius::error::Error::Cancelled` or equivalent), the `message` field MUST be exactly `"query cancelled"`, `code: None`, `line: None`, `procedure: None`.

The wire shape of `AppError::Mssql` (`{ kind: "Mssql", message: { code, message, line, procedure } }`) is stable across driver versions. Only the contents of the inner fields change. This requirement applies to every Tauri command that converts a tiberius error via the standard `From` impl, including `mssql_run_sql`, `mssql_run_sql_many`, `mssql_apply_table_edits`, `mssql_query_table`, and schema/columns commands.

#### Scenario: Unknown column surfaces server message

- **WHEN** the user runs `SELECT foo FROM [dbo].[users]` and SQL Server rejects it because `foo` does not exist
- **THEN** `AppError::Mssql.message.code` is `Some(207)`
- **AND** `AppError::Mssql.message.message` is exactly `"Invalid column name 'foo'."` (the verbatim server message)
- **AND** the SQL editor's error block renders that message verbatim

#### Scenario: Line is read from the TDS error token

- **WHEN** SQL Server reports a syntax error on line 3 of a multi-line batch
- **THEN** `AppError::Mssql.message.line` is `Some(3)`
- **AND** the editor places its line decoration on source line 3 (after offsetting for multi-statement runs)

#### Scenario: Error inside a procedure carries procedure name

- **WHEN** SQL Server raises an error inside `[dbo].[broken_proc]`
- **THEN** `AppError::Mssql.message.procedure` is `Some("broken_proc")` (or `Some("dbo.broken_proc")` if the server qualifies it)
- **AND** the editor renders `In procedure: <name>` in the error block

#### Scenario: Transport errors preserve driver diagnostic text

- **WHEN** a query fails because the TDS connection was closed mid-flight
- **THEN** `AppError::Mssql.message.message` falls back to the driver error's `Display` string (e.g. `"connection closed"`)
- **AND** `AppError::Mssql.message.code` is `None`
- **AND** `AppError::Mssql.message.line` is `None`
- **AND** `AppError::Mssql.message.procedure` is `None`

#### Scenario: Cancelled signal surfaces as a stable message

- **WHEN** the driver returns `tiberius::error::Error::Cancelled` for an in-flight run
- **THEN** `AppError::Mssql.message.message` is exactly `"query cancelled"`
- **AND** `AppError::Mssql.message.code` is `None`

#### Scenario: Activity log and query history pick up the server message

- **WHEN** a SQL run fails with a SQL Server error
- **THEN** the `argus:activity-log` event's `error.message` is the same server-message-derived string surfaced to the SQL editor
- **AND** the corresponding `query_history` row's `error_message` column is that same string
- **AND** the `error_code` column is the stringified numeric error number

### Requirement: Format SQL action

Each `mssql-query` tab SHALL render a thin toolbar at the top of the editor area containing a `Format` button. The editor SHALL also bind `Mod-Shift-F` to the same action at `Prec.highest` so it cannot be intercepted by other extensions. When invoked:

- The action MUST run the entire editor document through the project's `formatSql(input: string, dialect: "mssql"): string` helper, which MUST wrap `sql-formatter` configured with `{ language: "transactsql", keywordCase: "upper", identifierCase: "preserve", dataTypeCase: "upper", functionCase: "lower", indentStyle: "standard", tabWidth: 2, expressionWidth: 80, linesBetweenQueries: 1 }`.
- The action MUST replace the editor document with the formatted output via a single CodeMirror transaction so undo restores the pre-format text in one step.
- After replacement, the cursor MUST be set to offset 0 and the view scrolled to the top.
- If the document is empty or contains only whitespace, the action MUST be a no-op (no transaction dispatched, no error).
- If `sql-formatter` throws (malformed SQL it cannot tokenize), the editor MUST leave the document untouched and surface a non-blocking error toast `Could not format SQL`. The original buffer MUST NOT be lost.

`GO` directives MUST be preserved verbatim by the formatter (passed through as opaque tokens between batches). The formatter MUST NOT remove or relocate `GO` lines.

The `Format` button MUST display the keyboard shortcut hint `⌘⇧F` (or `Ctrl+Shift+F` on non-Mac) inline with the label so users discover the binding.

#### Scenario: Format button reformats the buffer

- **WHEN** the editor contains `select id,name from [dbo].[users] where id=1`
- **AND** the user clicks the `Format` button
- **THEN** the editor document becomes a multi-line formatted version with `SELECT` and `FROM` uppercased, fields aligned, 2-space indentation, and bracket identifiers preserved
- **AND** pressing `Mod-Z` once restores the original single-line text

#### Scenario: Mod-Shift-F triggers the same action

- **WHEN** the editor is focused with non-empty SQL and the user presses `Mod-Shift-F`
- **THEN** the buffer is reformatted identically to clicking the `Format` button
- **AND** the action fires exactly once

#### Scenario: Format on empty buffer is a no-op

- **WHEN** the editor is empty (or only whitespace)
- **AND** the user clicks `Format`
- **THEN** no transaction is dispatched and no error is shown

#### Scenario: Format on unparseable SQL preserves the buffer

- **WHEN** the editor contains text the formatter cannot tokenize (e.g. an unclosed bracket identifier)
- **AND** the user clicks `Format`
- **THEN** the editor document is unchanged
- **AND** a toast appears reading `Could not format SQL`

#### Scenario: Format preserves GO directives

- **WHEN** the editor contains `select 1\nGO\nselect 2\nGO 3`
- **AND** the user clicks `Format`
- **THEN** the formatted document still contains the `GO` and `GO 3` directives on their own lines in the same relative positions

### Requirement: Live elapsed-time indicator while running

While a run is in flight, the result header's summary slot SHALL display a live elapsed time that updates at 100ms intervals. The text MUST follow these rules, where `ms` is the elapsed time since the run started in the client:

- `ms < 1000` → `Running…`
- `1000 ≤ ms < 60000` → `Running… <s>s` where `<s>` is the elapsed seconds with one decimal (e.g. `Running… 1.2s`, `Running… 12.4s`)
- `ms ≥ 60000` → `Running… <m>:<ss>` where `<m>` is whole minutes and `<ss>` is two-digit seconds (e.g. `Running… 1:23`, `Running… 10:05`)

The interval MUST live on the result header component only (not in `useMssqlQueryRun` or any parent), so re-renders triggered by the tick MUST NOT re-render the editor, the grid, or any sibling tab. The interval MUST be cleared when the result-header component unmounts and when the run completes.

`useMssqlQueryRun` SHALL expose `run_started_at: number | null` (the `Date.now()` at which the most recent run transitioned to `running`, or `null` while idle/done) so the header can compute elapsed time without recreating the timer source.

When a run completes, the header MUST immediately switch to the existing post-completion summary (e.g. `5 rows · 12 ms`) — the server-reported `query_ms` is the source of truth for the final number, not the client-side elapsed time.

#### Scenario: Sub-second runs only show "Running…"

- **WHEN** a run is dispatched and 400ms have elapsed
- **THEN** the header summary reads `Running…` (no number)

#### Scenario: Mid-run elapsed time shows seconds with one decimal

- **WHEN** a run has been in flight for ~3500ms
- **THEN** the header summary reads `Running… 3.5s`
- **AND** the text updates approximately every 100ms

#### Scenario: Long-running query shows minute:second format

- **WHEN** a run has been in flight for 83000ms
- **THEN** the header summary reads `Running… 1:23`

#### Scenario: Completed run replaces timer with server-reported metric

- **WHEN** a run completes returning 5 rows in 12 ms (server `query_ms`)
- **THEN** within one tick the header summary reads `5 rows · 12 ms`
- **AND** the live interval is cleared (no further re-renders from the tick)

#### Scenario: Tick does not re-render the editor

- **WHEN** a run is in flight and the timer ticks at 100ms
- **THEN** the result-header component re-renders
- **AND** the editor component does not re-render (no new transactions dispatched, no `EditorView` reconfiguration)

### Requirement: Cancellation via TDS Attention with KILL fallback

Each `mssql-query` tab SHALL render a `Cancel` button next to the live elapsed-time indicator while a run is in flight. Clicking the button OR pressing `Mod-.` (Mac) / `Ctrl-.` (other) MUST invoke a Tauri command `mssql_cancel_run(connection_id, spid)` that:

1. **Primary path**: Trips the cancellation token associated with the in-flight run on the same pool connection so that `tokio::select!` drops the query future. Dropping the tiberius future causes the driver to send a TDS Attention packet, which signals the server to abandon the current statement. The connection is then returned to the pool (or invalidated by the pool's health check if the driver cannot guarantee state).
2. **Fallback path** (used when the primary path does not deliver Attention reliably in the pinned tiberius version): Opens a fresh short-lived MS SQL Server connection to the same host/port/user/database as the target connection, using the **same `encrypt_mode`** and `trust_server_certificate` as the target (so a TLS-required server is reachable). Executes `KILL <spid>` where `<spid>` is the integer session id (`@@SPID`) recorded on the pooled connection at the start of the run. Closes the short-lived connection.

The frontend MUST record the `@@SPID` of the pooled connection at run start (the backend MUST return it as part of an interim `run_started` event or by storing it on the in-flight run record returned by a `mssql_get_running_run` query). The cancel call MUST be fire-and-forget — the frontend MUST NOT wait for the cancel to succeed before clearing the indicator; the cancel UX is "submitted" the moment the cancel command returns.

When cancellation succeeds, the in-flight run MUST surface as `AppError::Mssql { code: None, message: "query cancelled", line: None, procedure: None }`. The runner MUST treat this envelope as a cancellation outcome and the result panel MUST render `Cancelled.` instead of the standard error block.

#### Scenario: Cancel button cancels the run

- **WHEN** a query has been running for 4 seconds and the user clicks `Cancel`
- **THEN** `mssql_cancel_run(connection_id, <spid>)` is invoked
- **AND** the original `mssql_run_sql` returns `AppError::Mssql { code: None, message: "query cancelled", ... }`
- **AND** the result panel renders `Cancelled.` instead of an error block

#### Scenario: Cancel shortcut works on Mac and other platforms

- **WHEN** the user presses `Mod-.` while a run is in flight
- **THEN** the cancel handler fires exactly once
- **AND** the editor's document is unchanged

#### Scenario: Cancel uses the same encrypt_mode as the original connection

- **WHEN** the target connection uses `encrypt_mode: Strict` and the fallback `KILL` path is exercised
- **THEN** the short-lived kill connection is opened with `encrypt_mode: Strict`
- **AND** the `KILL <spid>` succeeds against a TLS-strict server

#### Scenario: Cancel on an already-finished run is a no-op

- **WHEN** the user clicks `Cancel` but the run has already completed in the same tick
- **THEN** the cancel command MAY still send Attention or execute `KILL <spid>` (harmless on a finished query)
- **AND** the result panel renders the completed result, not `Cancelled.`

#### Scenario: Cancel records spid captured at run start

- **WHEN** a new run begins and `mssql_run_sql` selects `@@SPID` on the borrowed connection before dispatching the user SQL
- **THEN** the frontend can call `mssql_get_running_run(connection_id)` and observe the recorded `spid`
- **AND** clicking `Cancel` passes that exact `spid` to `mssql_cancel_run`

### Requirement: Per-tab timeout selector

Each `mssql-query` tab SHALL render a `Timeout: <Ns>` dropdown in the editor toolbar (to the right of the connection selector). The dropdown MUST list the values `15s` (default), `30s`, `45s`, and `60s`. The selected timeout MUST be sent as a per-call argument to `mssql_run_sql(connection_id, sql, origin, timeout_ms)` and to `mssql_run_sql_many(connection_id, statements, origin, timeout_ms)`. The backend MUST enforce this as the per-statement timeout (for `mssql_run_sql`) or the per-statement timeout within a 30s total cap (for `mssql_run_sql_many` — the run-wide 30s cap is unchanged regardless of the per-statement timeout selection).

The selected timeout MUST persist per tab id under settings key `mssqlQueryTimeoutMs:<tab_id>` while the tab exists. It MUST NOT persist across app launches.

#### Scenario: Default timeout is 15 seconds

- **WHEN** a new query tab is opened
- **THEN** the timeout dropdown reads `Timeout: 15s`
- **AND** invocations of `mssql_run_sql` pass `timeout_ms: 15000`

#### Scenario: Raised timeout is honored

- **WHEN** the user selects `Timeout: 60s` and runs a statement that takes 45 seconds
- **THEN** `mssql_run_sql` is invoked with `timeout_ms: 60000`
- **AND** the statement completes normally without a cancellation

#### Scenario: Run-many still capped at 30s total

- **WHEN** the user selects `Timeout: 60s` and presses `Mod-Shift-Enter` on a batch whose statements collectively exceed 30 seconds
- **THEN** the in-flight statement returns an `outcome: "err"` with `code: null` and message containing `"run timeout"` when 30 seconds elapse
- **AND** subsequent statements are `"skipped"`

### Requirement: Export single-statement rows result

The result panel SHALL render an `Export ▾` dropdown trigger inside the result header (positioned to the right of the run summary) when, and only when, ALL of the following are true:

- `runner.state.status === "done"`,
- `runner.state.mode === "single"`,
- `runner.state.result?.kind === "rows"`,
- `runner.state.result.rows.length > 0`.

Otherwise the dropdown trigger MUST NOT be rendered. (Multi-statement runs and `kind: "affected"` results MUST NOT show an export action in this version.)

The dropdown menu MUST list exactly three items in this order: `Export as CSV`, `Export as Excel (.xlsx)`, `Export as JSONL`. Selecting an item MUST:

1. Open a Tauri save dialog (`@tauri-apps/plugin-dialog`) with a default filename of the form `${connection_name}_query_${YYYYMMDD_HHmmss}.${ext}`, with `_truncated` inserted before the extension when `result.truncated === true`. The dialog's filter MUST match the chosen format (`*.csv`, `*.xlsx`, or `*.jsonl`).
2. If the user cancels (returns `null`), the action MUST silently no-op.
3. If the user confirms, the frontend MUST serialize the rows in the chosen format and write the file via `@tauri-apps/plugin-fs` (`writeTextFile` for CSV/JSONL, `writeFile` with a `Uint8Array` for XLSX).
4. On write success, surface a brief success toast (e.g. `Exported 5,000 rows`).
5. On write failure, surface an error toast with the failure message; the original result MUST remain untouched in memory.

The serializers MUST behave as follows:

- **CSV**: UTF-8 with a leading BOM. RFC 4180 quoting (a field is quoted iff it contains `"`, `,`, `\n`, or `\r`; embedded `"` is escaped as `""`). `null` cells become empty strings. The header row uses column `name`. Line ending is `\r\n`.
- **JSONL**: one JSON object per line, no trailing newline. Object keys are snake_case column `name` values from the result columns. `null` cells serialize as JSON `null`. Numbers, booleans, and other JSON-native types from the `Value` envelope serialize natively (no string coercion).
- **XLSX** (via `exceljs`, lazy-loaded on first invocation): a single sheet named `Result` with the header row at row 1 and frozen. Cell typing is driven by `DataColumn.data_type`:
  - integer types (`TINYINT`, `SMALLINT`, `INT`, `BIGINT`) and float types (`FLOAT`, `REAL`) → numeric cell when the parsed `Number` is finite, else string.
  - `DECIMAL` / `NUMERIC` / `MONEY` / `SMALLMONEY` → numeric cell when parseable as finite Number AND magnitude is within Excel's safe range, else string (preserve precision).
  - `BIT` → boolean cell.
  - `DATE`/`DATETIME`/`DATETIME2`/`SMALLDATETIME`/`DATETIMEOFFSET` types → `Date` cell when `new Date(value)` is not `NaN`, else string.
  - `XML` → string cell containing the XML text.
  - `JSON` (SQL Server 2025+) → string cell containing `JSON.stringify(value)`.
  - `UNIQUEIDENTIFIER` → string cell containing the canonical UUID.
  - `BINARY`/`VARBINARY`/`IMAGE`/`ROWVERSION` → string cell rendered as `0x<hex>` truncated to 32 characters (or empty for null).
  - everything else → string cell (or empty for null).
  Column widths SHOULD be derived from the longest cell up to a cap of 60 characters.

When `result.truncated === true`, the export MUST proceed using only the rows already in memory; the `_truncated` filename suffix is the user-visible signal that the export is partial. The export action MUST NOT re-execute the query without the row cap.

#### Scenario: Export trigger only appears for rows results

- **WHEN** a SELECT returns 5 rows and the run completes
- **THEN** the `Export ▾` trigger is rendered in the result header

#### Scenario: Export trigger hidden for affected results

- **WHEN** an INSERT returns `{ kind: "affected", ... }`
- **THEN** the `Export ▾` trigger is NOT rendered

#### Scenario: Export trigger hidden for multi-statement runs

- **WHEN** a multi-statement run completes (regardless of outcomes)
- **THEN** the `Export ▾` trigger is NOT rendered

#### Scenario: Export trigger hidden for empty rows

- **WHEN** a SELECT returns 0 rows
- **THEN** the `Export ▾` trigger is NOT rendered

#### Scenario: CSV export quotes embedded delimiters

- **WHEN** the result has a row whose first cell value is the string `a,b"c\nd`
- **AND** the user chooses `Export as CSV` and confirms a save path
- **THEN** the written file contains the field `"a,b""c\nd"` (with embedded quote escaped as `""` and the comma/newline forcing the surround quotes)
- **AND** the file begins with a UTF-8 BOM

#### Scenario: CSV export writes null cells as empty

- **WHEN** the result has a row with a `null` cell
- **AND** the user chooses `Export as CSV`
- **THEN** that field in the output is empty (two adjacent commas, with no quotes)

#### Scenario: JSONL export preserves JSON types and snake_case keys

- **WHEN** the result has columns `id (INT)`, `is_active (BIT)`, `display_name (NVARCHAR)`, `meta (JSON)` and a row `[7, true, null, {"k":"v"}]`
- **AND** the user chooses `Export as JSONL`
- **THEN** that line of the file is `{"id":7,"is_active":true,"display_name":null,"meta":{"k":"v"}}`

#### Scenario: XLSX export types numeric and date cells

- **WHEN** the result has a column `created_at` of type `DATETIME2` with value `"2026-05-06T12:00:00"` and a column `n` of type `INT` with value `42`
- **AND** the user chooses `Export as Excel (.xlsx)`
- **THEN** the written workbook's `Result` sheet has the `created_at` cell as a Date and the `n` cell as a Number (not strings)

#### Scenario: XLSX export renders UNIQUEIDENTIFIER as canonical string

- **WHEN** the result has a column `id` of type `UNIQUEIDENTIFIER` with value `"f81d4fae-7dec-11d0-a765-00a0c91e6bf6"`
- **AND** the user chooses `Export as Excel (.xlsx)`
- **THEN** the cell is a string cell containing exactly `f81d4fae-7dec-11d0-a765-00a0c91e6bf6`

#### Scenario: Truncated result exports with marker filename

- **WHEN** a SELECT returns 10000 rows with `truncated: true` and the user chooses `Export as CSV`
- **THEN** the save dialog's default filename ends with `_truncated.csv`
- **AND** the written file contains exactly 10000 data rows plus the header

#### Scenario: User cancels the save dialog

- **WHEN** the user chooses any export format and cancels the save dialog
- **THEN** no file is written and no toast appears

#### Scenario: Export reflects connection name in filename

- **WHEN** the active connection's name is `local-mssql` and the time is `2026-05-06 14:30:05`
- **AND** the user chooses `Export as JSONL` on a non-truncated result
- **THEN** the save dialog's default filename is `local-mssql_query_20260506_143005.jsonl`

### Requirement: Connection selector in editor toolbar

Each `mssql-query` tab SHALL render a connection selector control as the leftmost element of the editor toolbar (the same toolbar that hosts `Format` and `Save`). The selector MUST:

- Display the name of the currently-selected connection along with a status dot reusing the status visualization from the Connections sidebar (e.g. green when connected, gray when disconnected). When no connection is selected, the trigger shows the placeholder `Select connection…`.
- Open a dropdown listing every MS SQL Server connection registered in the connection registry, ordered the same way as the Connections sidebar (groups respected). Each item shows the connection name and the same status dot.
- On selection, update the tab's `current_connection_id` and `current_connection_name` in `useMssqlQueryTabState`.

Switching connections MUST:

1. Reconfigure the autocomplete `Compartment` of the editor to re-bind `schemaCompletionSource` to `mssqlSchemaCache.getNamespace(new_connection_id)`, following the same debounce and shape-equality skip rules already specified in "Schema-aware autocomplete from in-memory cache".
2. Discard the current `runner.state` (any prior result was bound to the previous connection). The result panel reverts to the empty hint state.
3. NOT mark the tab as dirty (the saved query record does not track connection).
4. When `state.saved_query_id` is set, persist the new `current_connection_id` to the saved query's `last_connection_id` via `saved_queries_update`, debounced 1000ms, fire-and-forget.

When the user invokes Run (`Mod-Enter`, `Mod-Shift-Enter`) with no connection selected, the frontend MUST surface a toast `Select a connection first.` and MUST NOT invoke `mssql_run_sql` or `mssql_run_sql_many`.

The selector's connection list MUST reactively update when connections are added, removed, renamed, or change connection state. The selector MUST only list connections whose `kind: "mssql"` — Postgres / MySQL / DynamoDB connections MUST NOT appear in a `mssql-query` tab's selector.

#### Scenario: Selector reflects current connection with status dot

- **WHEN** the tab's current connection is `prod_db` (MS SQL Server) and it is connected
- **THEN** the selector trigger displays `prod_db` with a green status dot

#### Scenario: Selector excludes non-MSSQL connections

- **WHEN** the registry contains two MS SQL Server connections, one MySQL connection, and one Postgres connection
- **THEN** the `mssql-query` tab's selector dropdown lists only the two MS SQL Server connections

#### Scenario: Changing connection re-binds autocomplete

- **WHEN** the user has the editor open with `prod_db` selected and types `SELECT * FROM dbo.` to confirm completions reflect `prod_db` schema
- **AND** the user changes the selector to `staging_db`
- **THEN** within ~100ms typing `SELECT * FROM dbo.` shows completions from `staging_db`'s schema cache (or empty if not loaded)
- **AND** the editor's syntax highlighting, undo history, and cursor are preserved

#### Scenario: Changing connection clears the result panel

- **WHEN** a result is displayed from a SELECT against `prod_db`
- **AND** the user changes the selector to `staging_db`
- **THEN** the result panel reverts to the empty hint state (`Press ⌘↩ to run · Tab to autocomplete`)
- **AND** the tab is NOT marked dirty by the connection change

#### Scenario: Run with no connection selected is rejected client-side

- **WHEN** the tab has no current connection and the user presses `Mod-Enter` with non-empty SQL
- **THEN** a toast `Select a connection first.` appears
- **AND** neither `mssql_run_sql` nor `mssql_run_sql_many` is invoked

#### Scenario: Selector persists last_connection_id for saved query

- **WHEN** a tab has `state.saved_query_id = "abc"` and the user changes the connection to `staging_db`
- **THEN** within ~1 second `saved_queries_update({ id: "abc", last_connection_id: "<staging_db uuid>" })` is invoked
- **AND** the tab is NOT marked dirty

### Requirement: Save action in editor toolbar

Each `mssql-query` tab SHALL render a `Save` button in the editor toolbar (to the right of the connection selector, before `Format`). The editor SHALL also bind `Mod-S` to the same action at `Prec.highest` so it cannot be intercepted by other extensions or browser defaults.

Saved MS SQL Server queries participate in the `saved-queries` capability with `kind: "mssql"`. When invoked, the action MUST:

- **First save (no `state.saved_query_id`)**: open a modal `SaveAsModal` with two fields — `Name` (text input, required, pre-filled with the tab title if non-default) and `Folder` (a tree picker of `saved_query_folders`, defaulting to the value stored in settings key `savedQueries:lastUsedFolder` or root if unset). The modal MUST provide a `+ New folder…` affordance that inline-creates a child folder under the current selection. On confirm:
  1. Invoke `saved_queries_create({ folder_id, name, kind: "mssql", sql: <current editor text>, last_connection_id: <current connection id or null> })`.
  2. Update tab state: `saved_query_id = record.id`, `saved_sql = record.sql`, `saved_name = record.name`, `saved_folder_id = record.folder_id`. Set `tab.title = record.name`.
  3. Persist `savedQueries:lastUsedFolder = folder_id` in settings.
  4. Surface a brief success toast `Saved as "<name>"`.

- **Subsequent saves (`state.saved_query_id` present)**: directly invoke `saved_queries_update({ id, name: <state.edited_name ?? saved_name>, sql: <current editor text> })`. No modal. On success, update `saved_sql` and `saved_name` to the new values and bump the tab title if the name changed. Surface a brief toast `Saved`.

The action MUST be a no-op (silent, no toast, no command) if the tab is not dirty (current SQL and name equal the saved snapshot). The action MUST still be invokable when the editor is empty (an empty saved query is valid).

#### Scenario: First save opens the modal

- **WHEN** the user has a new tab with `SELECT 1` typed and no `saved_query_id`
- **AND** the user presses `Mod-S`
- **THEN** a `SaveAsModal` appears with Name pre-filled, Folder defaulting to the last used folder
- **AND** confirming with name `Test` invokes `saved_queries_create` with `{ name: "Test", kind: "mssql", sql: "SELECT 1", folder_id, last_connection_id }`
- **AND** the tab's title becomes `Test` and its `state.saved_query_id` is set

#### Scenario: Subsequent save is direct overwrite

- **WHEN** a tab already has `state.saved_query_id = "abc"` and the user edits the SQL
- **AND** the user presses `Mod-S`
- **THEN** `saved_queries_update({ id: "abc", sql: <new sql>, name: <current name> })` is invoked
- **AND** no modal appears

#### Scenario: Save on clean tab is a no-op

- **WHEN** the tab's current SQL and name match the saved snapshot
- **AND** the user presses `Mod-S`
- **THEN** no command is invoked and no toast appears

#### Scenario: Mod-S binding wins over default keymap

- **WHEN** the editor is focused and the user presses `Mod-S`
- **THEN** the save action fires exactly once
- **AND** no browser "Save Page" dialog appears
- **AND** no other extension intercepts the keystroke

### Requirement: Dirty state tracking and unsaved-changes confirmation

Each `mssql-query` tab SHALL track a `dirty: boolean` derived from:

- For tabs with `state.saved_query_id`: `dirty = (current_sql !== saved_sql) || (current_name !== saved_name)`.
- For tabs without `state.saved_query_id`: `dirty = current_sql.trim().length > 0`.

The dirty state MUST surface visually as a leading `●` character before the tab title in the tab strip. The tooltip on the dirty indicator MUST read `Unsaved changes`.

Changing the current connection MUST NOT affect `dirty`. Successfully running the query MUST NOT clear `dirty`. Only a successful `Save` (or reverting edits to match the saved snapshot) clears `dirty`.

When the user attempts to close a `dirty` tab via `Mod-W` or the tab close button:

- If the tab has `state.saved_query_id`: show a confirmation dialog `Discard unsaved changes to "<name>"?` with buttons `Discard` (destructive) and `Cancel` (default). Only `Discard` proceeds with closing.
- If the tab has NO `state.saved_query_id` (never-saved scratch buffer with content): close immediately without prompt (preserves the existing "Tab close discards buffer without confirm" behavior for ad-hoc queries).

After closing in either case, the `mssqlQueryBuffer:<tab_id>` settings key MUST still be removed per the existing requirement.

#### Scenario: Editing a saved query marks it dirty

- **WHEN** a tab is bound to a saved query and the user types one character into the editor
- **THEN** the tab title is prefixed with `● `
- **AND** the tooltip on the dot reads `Unsaved changes`

#### Scenario: Reverting edits clears dirty

- **WHEN** a tab is dirty because of one edit
- **AND** the user undoes that edit so the buffer matches `saved_sql` again
- **THEN** the leading `● ` disappears from the tab title

#### Scenario: Saving clears dirty

- **WHEN** a dirty tab is saved via `Mod-S`
- **THEN** the leading `● ` disappears immediately on success

#### Scenario: Connection change does not mark dirty

- **WHEN** a clean tab (no `● `) has the connection switched via the toolbar selector
- **THEN** the tab remains clean (no `● `)

#### Scenario: Closing dirty saved query prompts to discard

- **WHEN** a tab has `state.saved_query_id` set and is dirty, and the user presses `Mod-W`
- **THEN** a confirmation dialog `Discard unsaved changes to "<name>"?` appears
- **AND** clicking `Cancel` keeps the tab open
- **AND** clicking `Discard` closes the tab and removes the `mssqlQueryBuffer:<tab_id>` key

#### Scenario: Closing dirty ad-hoc tab is immediate

- **WHEN** a tab has no `state.saved_query_id` and is dirty (non-empty SQL)
- **AND** the user presses `Mod-W`
- **THEN** the tab closes immediately without a prompt
- **AND** the `mssqlQueryBuffer:<tab_id>` key is removed

### Requirement: SQL identifier rendering uses square brackets

Every SQL snippet emitted by the editor or by entry points that route into the editor (e.g. "New Query Here" on a database/schema node, "Insert column reference" from the schema browser, the "Open as SELECT" affordance on a table node, the data viewer's "Open in SQL Editor" action) MUST quote MS SQL Server identifiers with square brackets (`[ ]`), NOT double quotes or backticks.

Specifically:

- A table reference MUST be rendered `[schema].[table]` when both schema and table are known, or `[table]` when only the table is in scope (current default schema).
- A column reference MUST be rendered as `[column]` (or `[table].[column]` when disambiguation against a join is needed).
- The "Open as SELECT" affordance MUST emit exactly `SELECT TOP 100 * FROM [schema].[table];` (with a trailing semicolon).
- Internal helpers that escape identifiers MUST escape an embedded `]` by doubling it: `]` → `]]` (per MS SQL Server identifier escaping rules). Identifiers MUST NOT escape `[` (only the closing bracket needs doubling).

Two-part naming (`[schema].[table]`) is the canonical form. The editor MUST NOT emit three-part names (`[database].[schema].[table]`) since each connection is scoped to one database; if the user wants to cross databases they MUST write it themselves.

#### Scenario: Open as SELECT emits bracketed identifiers

- **WHEN** the user right-clicks the table `dbo.users` in the schema browser and selects `Open as SELECT`
- **THEN** a new `mssql-query` tab opens with the editor document `SELECT TOP 100 * FROM [dbo].[users];`

#### Scenario: New Query Here uses current schema

- **WHEN** the user right-clicks the schema node `sales` and selects `New Query Here`
- **THEN** a new `mssql-query` tab opens with the connection's default schema context set to `sales` (used to disambiguate unqualified references in autocomplete) and an empty editor

#### Scenario: Column reference insertion uses brackets

- **WHEN** the user double-clicks the column `email` of the table `dbo.users` in the schema browser while the editor is focused
- **THEN** the editor inserts the text `[email]` at the cursor position

#### Scenario: Identifier with embedded ] is doubled

- **WHEN** an internal helper renders the identifier `weird]name` (a closing bracket inside)
- **THEN** the rendered SQL is `[weird]]name]`

#### Scenario: No three-part naming in emitted SQL

- **WHEN** any built-in affordance (Open as SELECT, prefilled SELECT, column insertion) emits SQL for a table
- **THEN** the emitted SQL uses two-part `[schema].[table]` form, never `[db].[schema].[table]`

### Requirement: Query tab result and editor state survive tab switches

A `mssql-query` tab SHALL retain the following in-memory state across any sequence of tab activations and deactivations within the same app session:

- The CodeMirror editor document (already covered by the existing `mssqlQueryBuffer:<tab_id>` persistence requirement, but MUST also be preserved without a settings round-trip on activation).
- The editor's caret position, selection range, scroll position, and undo history.
- The last query result(s) — rows, affected counts, multi-statement sub-tabs, the active sub-tab — for as long as the tab is open.
- Error blocks (numeric code, line, procedure, server message) from the most recent failed run.
- The live elapsed-time indicator state for any in-flight run.
- Read-only banner visibility (derived from connection state — must remain consistent on return).
- The per-tab timeout selector value.

Switching away from a query tab and back MUST NOT re-execute the last query, MUST NOT clear the result, and MUST NOT reset the editor selection or scroll position.

A query tab MAY re-execute only in response to the user explicitly running it (the Run shortcut, the Run button, or the statement-under-cursor action).

Closing a query tab MUST discard the retained result and editor state. The existing `Tab close discards buffer without confirm` requirement applies unchanged.

#### Scenario: Query result persists across tab switch

- **WHEN** the user runs `SELECT TOP 10 * FROM [dbo].[users]` in a query tab, observes the result panel, switches to another tab, then returns
- **THEN** the result panel still shows the same 10 rows
- **AND** no `mssql_run_sql` (or equivalent run command) is dispatched as a result of the activation
- **AND** the editor caret is in the same position as before

#### Scenario: Multi-statement sub-tab choice persists

- **WHEN** the user runs three statements and clicks the second result sub-tab, then switches tabs and returns
- **THEN** the second result sub-tab is still active

#### Scenario: Error block persists across tab switch

- **WHEN** the user runs a statement that produces a SQL Server error, switches tabs, and returns
- **THEN** the same error block (code, line, procedure, server message) is still rendered
- **AND** no automatic re-run occurs

#### Scenario: In-flight run continues while tab is hidden

- **WHEN** the user runs a long query and switches to another tab before it completes
- **THEN** the query continues to execute in the background
- **AND** when the user returns to the query tab, the result is already rendered (or the elapsed-time indicator continues if still running)

#### Scenario: Closing the tab drops the retained result

- **WHEN** the user closes a query tab that had a result rendered
- **THEN** the retained result is released along with the tab's renderer
- **AND** reopening "New Query" creates a fresh tab with an empty editor and no result

