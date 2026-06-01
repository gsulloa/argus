# mysql-sql-editor Specification

## Purpose
TBD - created by archiving change add-mysql-support. Update Purpose after archive.
## Requirements
### Requirement: Run SQL command (single statement)

The MySQL module SHALL expose a Tauri command `mysql_run_sql(connection_id, sql, origin?)` that executes exactly one SQL statement against the connection's pool and returns a discriminated `RunSqlResult` payload. The `origin` argument MUST be `"user"` or `"auto"` and defaults to `"user"` when absent (this command is always user-driven; defaulting to `"user"` matches the contract). The command MUST acquire a connection from the existing MySQL pool registry, MUST NOT open a new connection, and MUST classify the statement via the existing `is_mutating_sql` helper (shared across dialects):

- If the statement is non-mutating (SELECT, SHOW, EXPLAIN, DESCRIBE, WITH-only-reads, etc.), it MUST execute through the pool's read-only-aware `mysql_execute_query` path.
- If the statement is mutating (INSERT, UPDATE, DELETE, REPLACE, DDL, GRANT, etc.) AND the connection has `params.read_only: true`, the command MUST return `AppError::Validation { message: "connection is read-only" }` BEFORE dispatching the SQL to MySQL.
- Otherwise the statement MUST execute through `mysql_execute_mutation`.

The response MUST be one of:

- `{ kind: "rows", columns: Array<ColumnInfo>, rows: Array<Array<Value>>, query_ms: number, truncated_columns: string[], truncated: boolean }` — used when the statement returns a row set (any SELECT, SHOW, EXPLAIN, etc.). The `columns`, `rows`, and `truncated_columns` fields MUST follow the same shape as `mysql_query_table` (snake_case keys, same `Value` envelope handling for binary/truncated cells). `truncated: true` indicates the row count hit the cap (see "Result row cap").
- `{ kind: "affected", command_tag: string, affected_rows: number, query_ms: number }` — used when the statement returns no rows. `command_tag` MUST be the MySQL command name derived from the first keyword of the statement (e.g. `"INSERT"`, `"UPDATE"`, `"DELETE"`, `"CREATE TABLE"`, `"ALTER TABLE"`, `"DROP TABLE"`, `"USE"`, `"SET"`, `"REPLACE"`, `"TRUNCATE TABLE"`). `affected_rows` MUST be the integer reported by the MySQL client driver (0 when not applicable, e.g. for DDL).

On error the command MUST return `AppError::Mysql { code: Option<String>, message: String, position: Option<u32> }` where:

- `code` is the 5-character SQLSTATE returned by the MySQL server when present.
- `message` is the server-supplied error message verbatim (see "MySQL server message surfaces verbatim in error envelope").
- `position` is a 1-based character offset into the source SQL extracted by parsing the server's `"near 'X' at line N"` hint and translating `(line, column)` to a character offset against the original SQL text. When the server does not provide a parseable position (transport errors, semantic errors without a position), `position` MUST be `None`.

The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "run_sql"`, `connection_id: <id>`, `origin: <origin argument>`, `sql: <full SQL text>`, `params: null`, `metric: { kind: "items", value: <returned-row-count or affected-row-count> }` on success, `metric: null` on failure, and `status` matching the result.

#### Scenario: SELECT returns rows envelope

- **WHEN** the user invokes `mysql.runSql(id, "SELECT id, name FROM `app`.`users` LIMIT 5", "user")`
- **THEN** the response is `{ kind: "rows", columns: [{ name: "id", ... }, { name: "name", ... }], rows: [[...], ...], query_ms, truncated_columns, truncated: false }`
- **AND** one `argus:activity-log` event is emitted with `kind: "run_sql"`, `status: "ok"`, `metric: { kind: "items", value: 5 }`, `origin: "user"`, `sql` containing the SELECT, `params: null`

#### Scenario: SHOW returns rows envelope

- **WHEN** the user invokes `mysql.runSql(id, "SHOW TABLES", "user")`
- **THEN** the response is `{ kind: "rows", columns: [...], rows: [...], ... }`
- **AND** the activity-log event has `metric: { kind: "items", value: <row count> }`

#### Scenario: INSERT returns affected envelope

- **WHEN** the user invokes `mysql.runSql(id, "INSERT INTO `app`.`users` (name) VALUES ('a'), ('b'), ('c')", "user")` against a writable connection
- **THEN** the response is `{ kind: "affected", command_tag: "INSERT", affected_rows: 3, query_ms }`
- **AND** the activity-log event has `metric: { kind: "items", value: 3 }`

#### Scenario: DDL returns affected envelope with zero rows

- **WHEN** the user invokes `mysql.runSql(id, "CREATE TABLE foo (id int)", "user")` against a writable connection
- **THEN** the response is `{ kind: "affected", command_tag: "CREATE TABLE", affected_rows: 0, query_ms }`

#### Scenario: REPLACE returns affected envelope

- **WHEN** the user invokes `mysql.runSql(id, "REPLACE INTO `app`.`users` (id, name) VALUES (1, 'x')", "user")`
- **THEN** the response is `{ kind: "affected", command_tag: "REPLACE", affected_rows: <n>, query_ms }`

#### Scenario: Mutation on read-only connection rejected before dispatch

- **WHEN** the user invokes `mysql.runSql(id, "DELETE FROM `app`.`users`", "user")` and the connection has `params.read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }`
- **AND** the SQL is NOT dispatched to MySQL
- **AND** an activity-log event is emitted with `status: "err"`, `error.message` matching the validation message

#### Scenario: SELECT on read-only connection succeeds

- **WHEN** the user invokes `mysql.runSql(id, "SELECT 1", "user")` against a read-only connection
- **THEN** the response is `{ kind: "rows", ... }` with one row
- **AND** no validation error is raised

#### Scenario: Origin defaults to user

- **WHEN** the caller invokes `mysql.runSql(id, "SELECT 1")` without supplying `origin`
- **THEN** the activity-log event has `origin: "user"`

#### Scenario: MySQL syntax error includes position

- **WHEN** the user invokes `mysql.runSql(id, "SELEC 1", "user")` (typo)
- **THEN** the command returns `AppError::Mysql { code: Some("42000"), message, position: Some(<1-based offset>) }`
- **AND** the `position` corresponds to the offset of `SELEC` inside the source SQL (derived from the server's `"near 'SELEC 1' at line 1"` hint)
- **AND** an activity-log event is emitted with `status: "err"`, `error.code: "42000"`, `metric: null`

#### Scenario: Read-only SQLSTATE 25006 from server is surfaced friendly

- **WHEN** the connection's server-level configuration rejects a write with SQLSTATE `25006` (read-only transaction) even though the client did not pre-validate
- **THEN** the command returns `AppError::Mysql { code: Some("25006"), message: "connection is read-only: <original server message>", position: None }`
- **AND** the activity-log event records `error.code: "25006"`

### Requirement: Run multi-statement command

The MySQL module SHALL expose a Tauri command `mysql_run_sql_many(connection_id, statements, origin?)` that executes a list of pre-split SQL statements sequentially on the **same** pool connection and returns a `{ outcomes: [...] }` payload. The `statements` argument MUST be a `Vec<String>` already split by the frontend (the backend MUST NOT re-split). The `origin` argument defaults to `"user"`. The command MUST hold the same connection borrowed from the pool across all statements (so that session-scoped statements like `USE <db>`, `SET @v := ...`, `SET SESSION ...` persist across the run) and MUST release the connection when the run completes (success, error, or skip).

For each statement the command MUST apply the same classification logic as `mysql_run_sql` (read-only enforcement via `is_mutating_sql`, choice of `mysql_execute_query` vs `mysql_execute_mutation`). The response MUST be `{ outcomes: Array<{ index: number, sql: string, outcome: "ok" | "err" | "skipped", result?: RunSqlResult, error?: { message: string, code: string | null, position: number | null } }> }`. On the first statement that returns an error:

- That entry MUST have `outcome: "err"` and the error populated.
- ALL subsequent entries MUST have `outcome: "skipped"` with no `result` and no `error`.

The command MUST NOT wrap the run in an implicit `START TRANSACTION`/`COMMIT`. Each statement commits on its own (MySQL autocommit default). If the user wants atomicity, they include `START TRANSACTION` and `COMMIT` as explicit statements.

The command SHALL emit exactly one `argus:activity-log` event for the entire run, with `kind: "run_sql_many"`, `connection_id: <id>`, `origin: <origin>`, `sql: <statements joined by ";\n">`, `params: null`, `metric: { kind: "items", value: <sum of affected_rows or returned-row-count across all "ok" statements> }` on success, `metric: null` if any statement errored, and `status: "ok"` iff every statement was `"ok"`, `"err"` otherwise.

The total run MUST be bounded by a 30-second wall-clock timeout. Each individual statement MUST be bounded by a 15-second per-statement timeout (raisable per-tab per the "Per-tab timeout selector" requirement). On timeout, the in-flight statement's entry MUST be `outcome: "err"` with `code: Some("70100")` and a message indicating the timeout source (`"statement timeout"` or `"run timeout"`).

#### Scenario: Three successful statements return three outcomes

- **WHEN** the user invokes `mysql.runSqlMany(id, ["SELECT 1", "SELECT 2", "SELECT 3"], "user")`
- **THEN** the response is `{ outcomes: [{ index: 0, sql: "SELECT 1", outcome: "ok", result: { kind: "rows", ... } }, { index: 1, sql: "SELECT 2", outcome: "ok", result: { kind: "rows", ... } }, { index: 2, sql: "SELECT 3", outcome: "ok", result: { kind: "rows", ... } }] }`
- **AND** one `argus:activity-log` event is emitted with `kind: "run_sql_many"`, `status: "ok"`, `metric.value: 3`

#### Scenario: Failure halts execution and skips remaining

- **WHEN** the user invokes `mysql.runSqlMany(id, ["SELECT 1", "SELEC 2", "SELECT 3"], "user")`
- **THEN** the response is `{ outcomes: [{ index: 0, outcome: "ok", result: { kind: "rows", ... } }, { index: 1, outcome: "err", error: { code: "42000", ... } }, { index: 2, outcome: "skipped" }] }`
- **AND** the activity-log event has `status: "err"`, `metric: null`

#### Scenario: Session settings persist across statements

- **WHEN** the user invokes `mysql.runSqlMany(id, ["USE `analytics`", "SELECT DATABASE()"], "user")` against a writable connection
- **THEN** the second statement returns the row `"analytics"` as the current database
- **AND** both entries have `outcome: "ok"`

#### Scenario: User-defined variable persists across statements

- **WHEN** the user invokes `mysql.runSqlMany(id, ["SET @x := 42", "SELECT @x"], "user")`
- **THEN** the second statement returns the row `42`
- **AND** both entries have `outcome: "ok"`

#### Scenario: Mutation in middle of multi-run on read-only is rejected at that index

- **WHEN** the user invokes `mysql.runSqlMany(id, ["SELECT 1", "DELETE FROM `app`.`users`", "SELECT 2"], "user")` against a read-only connection
- **THEN** outcome 0 is `"ok"`, outcome 1 is `"err"` with the read-only validation error, outcome 2 is `"skipped"`

#### Scenario: Per-statement timeout aborts long statement

- **WHEN** the user invokes `mysql.runSqlMany(id, ["SELECT 1", "SELECT SLEEP(20)", "SELECT 2"], "user")` with the default 15-second per-statement timeout
- **THEN** outcome 0 is `"ok"`, outcome 1 is `"err"` with `error.code: "70100"` and a message containing `"statement timeout"`, outcome 2 is `"skipped"`

#### Scenario: Total run timeout halts the batch

- **WHEN** the user invokes `mysql.runSqlMany(id, [<many statements totalling more than 30s of work>], "user")`
- **THEN** the in-flight statement's outcome is `"err"` with `error.code: "70100"` and message containing `"run timeout"`
- **AND** every statement after it is `"skipped"`

### Requirement: Statement splitting (client-side splitter contract)

The frontend SHALL split the editor document into statements using a MySQL-aware splitter that the backend trusts. The splitter MUST:

- Recognize single-quoted string literals (`'...'`) with `''` and `\'` escapes (assuming `NO_BACKSLASH_ESCAPES` is OFF, which is MySQL's default; the splitter MUST treat backslash as an escape character inside `'...'` and `"..."` literals).
- Recognize double-quoted string literals (`"..."`) with `""` and `\"` escapes. (When the server is in `ANSI_QUOTES` mode these are identifiers, not strings — the splitter does not differentiate because either way semicolons inside `"..."` MUST NOT be treated as terminators.)
- Recognize backtick-quoted identifiers (`` `...` ``); backticks cannot contain raw semicolons in well-formed MySQL but the splitter MUST nevertheless not split inside a backtick run.
- Recognize MySQL comments:
  - `-- ` line comments — the splitter MUST require `--` to be followed by whitespace, tab, or end-of-line to count as a comment opener. `--foo` is NOT a comment (this matches MySQL parsing strictly).
  - `# ` line comments (MySQL-specific) — `#` starts a line comment when not inside a string/identifier/backtick.
  - `/* ... */` block comments — non-nested. The splitter MUST recognize `/*! ... */` optimizer hints as a block comment for splitting purposes (the contents are not parsed).
- NOT split inside `BEGIN ... END` compound blocks used by stored routines.

For v1, the splitter is a simple `;`-based split that respects the lexical rules above and does NOT attempt to handle `DELIMITER` directives or `BEGIN ... END` routine bodies. When a statement begins with any of `CREATE PROCEDURE`, `CREATE FUNCTION`, `CREATE TRIGGER`, or `CREATE EVENT` (case-insensitive, after stripping leading whitespace and comments), the frontend MUST reject the multi-statement run before calling the backend with `AppError::Validation { message: "DELIMITER blocks not supported in multi-statement runs; run as a single statement" }` and the editor MUST surface that error in the result panel.

The single-statement runner (`mysql_run_sql`) MUST NOT enforce this restriction — running a `CREATE PROCEDURE ... BEGIN ... END` body as a single statement against the backend is allowed and the backend MUST pass it through to the MySQL server as-is (the user's server-side `DELIMITER` is not required because the entire body is one Tauri call).

#### Scenario: Splitter respects single-quoted strings

- **WHEN** the document is `SELECT 'a;b'; SELECT 1;` and the cursor is in the second statement
- **THEN** the splitter yields exactly two statements (`SELECT 'a;b'` and `SELECT 1`)
- **AND** `Mod-Enter` runs `SELECT 1`

#### Scenario: Splitter respects backtick identifiers with semicolons handled correctly

- **WHEN** the document is `` SELECT * FROM `weird;name`; SELECT 1; `` (a literal backtick identifier containing a semicolon — pathological but legal in MySQL)
- **THEN** the splitter yields exactly two statements

#### Scenario: Splitter respects # line comments

- **WHEN** the document is `SELECT 1; # comment ; with semicolon\nSELECT 2;`
- **THEN** the splitter yields exactly two statements

#### Scenario: Splitter treats `--` strictly

- **WHEN** the document is `SELECT 1--foo;\nSELECT 2;`
- **THEN** the splitter yields **one** statement (`SELECT 1--foo` is treated as a single statement because `--foo` is not a comment — `--` must be followed by whitespace or EOL)

#### Scenario: Splitter respects `--` followed by space

- **WHEN** the document is `SELECT 1; -- a comment;\nSELECT 2;`
- **THEN** the splitter yields exactly two statements

#### Scenario: Splitter recognizes block comments and optimizer hints

- **WHEN** the document is `SELECT /*! STRAIGHT_JOIN */ 1; /* end ; */ SELECT 2;`
- **THEN** the splitter yields exactly two statements

#### Scenario: Routine creation rejected client-side from multi-run

- **WHEN** the user presses `Mod-Shift-Enter` on a buffer whose first non-whitespace statement starts with `CREATE PROCEDURE p() BEGIN SELECT 1; END`
- **THEN** the frontend surfaces a validation error `DELIMITER blocks not supported in multi-statement runs; run as a single statement`
- **AND** no Tauri call is made

#### Scenario: Routine creation accepted as a single statement run

- **WHEN** the user selects the entire `CREATE PROCEDURE p() BEGIN SELECT 1; END` body and presses `Mod-Enter`
- **THEN** `mysql_run_sql` is invoked with the full body as a single `sql` argument
- **AND** the backend dispatches it to MySQL unchanged

### Requirement: Result row cap

`mysql_run_sql` and each step of `mysql_run_sql_many` SHALL cap the returned row set at 10,000 rows. When a query produces more than 10,000 rows, the backend MUST return the first 10,000 in `rows`, MUST set `truncated: true` in the response, and MUST stop fetching further rows from the server (drop the iterator / discard the remainder). The cap is per-statement, not per-run. The `query_ms` MUST measure end-to-end including the time spent fetching the cap-many rows.

#### Scenario: Query returning under cap is not truncated

- **WHEN** a SELECT returns 4,200 rows
- **THEN** the response has `rows.length === 4200` and `truncated: false`

#### Scenario: Query exceeding cap is truncated to 10,000 with marker

- **WHEN** a SELECT against a 1M-row table runs without LIMIT
- **THEN** the response has `rows.length === 10000` and `truncated: true`
- **AND** the activity-log event metric is `{ kind: "items", value: 10000 }`

### Requirement: Query tab kind

The frontend SHALL register a tab kind `mysql-query` and SHALL render it in the center work area when the user activates a "New Query" entry point (sidebar button, palette command, double-click on a saved query). The tab payload MUST be `{ connection_id?: string, connection_name?: string, sql: string, saved_query_id?: string }`. The tab MUST have an id of the form `mysqlquery:<uuid>` where `<uuid>` is a fresh v4 UUID generated on tab creation; the id MUST NOT embed the connection id (the connection is mutable in runtime — see "Connection selector in editor toolbar").

The current connection of a tab MUST live in per-tab state (`useMysqlQueryTabState`), not in the tab payload or in the tab id. When the tab is created, the current connection is initialized from `connection_id` (or from the most recently-used connection of the saved query if `saved_query_id` is provided and the persisted `last_connection_id` references an existing connection), or unset if neither is available.

The default tab title MUST be:

- The saved query's `name` when `saved_query_id` is provided.
- `Query <N>` otherwise, where `N` is a global running counter (shared across dialects) starting at 1. The counter resets when the app launches.

Activating "New Query" with no `saved_query_id` MUST always create a new tab (never focus an existing one). Activating "Open" on a saved query whose `saved_query_id` matches an already-open tab MUST focus the existing tab instead of creating a new one. The "Open in new tab" action on a saved query MUST always create a new tab.

#### Scenario: New Query opens a fresh tab without a saved query binding

- **WHEN** the user clicks `+ Query` from the MySQL sidebar
- **THEN** a center-area tab of kind `mysql-query` opens with payload `{ connection_id: <current focused connection or undefined>, sql: "", saved_query_id: undefined }` and id `mysqlquery:<uuid>`
- **AND** the tab title is `Query <N>` for the next global counter value

#### Scenario: Opening a saved query reuses existing tab

- **WHEN** a `mysql-query` tab already exists with `state.saved_query_id === "abc"`
- **AND** the user double-clicks the saved query `abc` in the sidebar tree
- **THEN** the existing tab is focused (no new tab created)

#### Scenario: Opening a saved query in a new tab forces creation

- **WHEN** a `mysql-query` tab already exists with `state.saved_query_id === "abc"`
- **AND** the user selects `Open in new tab` from the context menu on saved query `abc`
- **THEN** a second `mysql-query` tab is created with `state.saved_query_id === "abc"` and a fresh `mysqlquery:<uuid>` id
- **AND** both tabs coexist in the tab strip

#### Scenario: Saved query restores last_connection_id when present

- **WHEN** the user opens saved query `abc` and its persisted `last_connection_id` is `conn-prod` which is a currently registered MySQL connection
- **THEN** the new tab's current connection is set to `conn-prod` and the editor toolbar's connection selector reflects this

#### Scenario: Saved query without a valid last connection opens with selector empty

- **WHEN** the user opens a saved query whose `last_connection_id` is null OR references a connection that no longer exists in the registry
- **THEN** the tab opens with no current connection and the editor toolbar's selector shows a placeholder prompting selection

### Requirement: CodeMirror editor with MySQL dialect

Each `mysql-query` tab SHALL render a CodeMirror 6 editor with `@codemirror/lang-sql` configured with the `MySQL` dialect. The editor MUST use `Geist Mono` per `DESIGN.md`, render with the app's current theme tokens (`var(--surface)` background, `var(--border)` for the gutter divider, `var(--accent)` for selection), and mount directly via `EditorView` on a `ref`'d `<div>` (no React wrapper around CodeMirror). The editor MUST provide line numbers, syntax highlighting for SQL keywords/strings/comments, bracket matching, multi-cursor support (Mod-D), comment-line toggle (Mod-/), and indentation via Tab / Shift-Tab. The editor MUST take focus on tab open.

The Tab key SHALL behave context-sensitively:

- When the autocomplete popup is open with an active suggestion (`completionStatus(state) === "active"`), Tab MUST accept the highlighted suggestion (equivalent to `acceptCompletion`).
- Otherwise, Tab MUST insert one indent level (`indentMore`).

Shift-Tab MUST always dedent (`indentLess`), regardless of popup state.

The comment-line toggle MUST use `-- ` (the MySQL-strict form with trailing space) so that toggling produces parseable comments even on the most strict server modes.

#### Scenario: Editor mounts with empty SQL on new tab

- **WHEN** the user opens a `mysql-query` tab for the first time
- **THEN** an empty editor is rendered with focus, line number 1 visible, and the gutter using `var(--border)`

#### Scenario: SQL syntax highlighting is active

- **WHEN** the user types `SELECT id FROM users WHERE id = 1`
- **THEN** `SELECT`, `FROM`, `WHERE` are highlighted as keywords
- **AND** `1` is highlighted as a numeric literal

#### Scenario: Backtick identifier is highlighted

- **WHEN** the user types `` SELECT `id` FROM `users` ``
- **THEN** the backtick-delimited tokens are highlighted as identifiers (not strings)

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
- Otherwise it MUST run the **statement under the cursor**, where the statement is determined by splitting the editor's full document with the MySQL-aware splitter defined in "Statement splitting (client-side splitter contract)". The cursor's offset MUST be matched against the statement ranges; if the cursor sits in whitespace between two statements, the editor MUST run the immediately preceding statement.
- If the cursor is in the document body and no statements exist (e.g. only whitespace and comments), the editor MUST surface a non-blocking toast `Nothing to run.` and MUST NOT invoke the backend.

The editor SHALL also bind `Mod-Shift-Enter` to "run all" — execute every statement in the document as a multi-statement run, regardless of cursor or selection — also at `Prec.highest`.

When a single statement is to be executed, the frontend MUST invoke `mysql_run_sql`. When two or more statements are to be executed (only via run-all), the frontend MUST invoke `mysql_run_sql_many` with the array produced by the splitter.

This editor MUST NOT bind itself to nor accept user-supplied `?` placeholder values: the user writes literal SQL and runs it as-is. The MySQL prepared-statement `?` placeholder is recognized only as a lexical token (not highlighted as a keyword) — the editor does not prompt for parameter values.

#### Scenario: Run with selection sends only the selection

- **WHEN** the user has the document `SELECT 1; SELECT 2;` and selects exactly `SELECT 2`, then presses `Mod-Enter`
- **THEN** `mysql_run_sql` is invoked with `sql: "SELECT 2"`

#### Scenario: Run without selection picks statement under cursor

- **WHEN** the document is `SELECT 1;\nSELECT 2;\nSELECT 3;` with the cursor on line 2
- **AND** the user presses `Mod-Enter`
- **THEN** `mysql_run_sql` is invoked with `sql: "SELECT 2"`

#### Scenario: Splitter ignores semicolons inside strings

- **WHEN** the document is `SELECT 'a;b'; SELECT 1;` and the cursor is in the second statement
- **THEN** the splitter yields exactly two statements (`SELECT 'a;b'` and `SELECT 1`)
- **AND** `Mod-Enter` runs `SELECT 1`

#### Scenario: Run all invokes run_sql_many

- **WHEN** the document has three statements separated by `;` and the user presses `Mod-Shift-Enter`
- **THEN** `mysql_run_sql_many` is invoked with the array of three statement strings (in order)

#### Scenario: Cursor in whitespace runs preceding statement

- **WHEN** the document is `SELECT 1;\n\nSELECT 2;` with the cursor on the empty line between them
- **AND** the user presses `Mod-Enter`
- **THEN** `mysql_run_sql` is invoked with `sql: "SELECT 1"`

#### Scenario: Mod-Enter wins over default keymap

- **WHEN** the editor is focused and the user presses `Mod-Enter`
- **THEN** the run handler fires exactly once
- **AND** the editor's document is NOT modified (no newline is inserted by any default `Enter`-family binding)

#### Scenario: Literal `?` placeholder is preserved verbatim

- **WHEN** the user types `SELECT * FROM `app`.`users` WHERE id = ?` and presses `Mod-Enter`
- **THEN** the SQL sent to `mysql_run_sql` contains the literal `?` character unchanged
- **AND** the editor does NOT prompt for a parameter value (the server will reject the unbound `?` with its own error, which the editor surfaces normally)

### Requirement: Schema-aware autocomplete from in-memory cache

The editor SHALL offer autocomplete suggestions from **three composed sources** running in parallel inside a single `autocompletion({ override: [...] })` extension:

1. **Keyword source** — `keywordCompletionSource(MySQL, /*upperCase=*/ true)` from `@codemirror/lang-sql`. Always available; suggests reserved words and built-in functions of the MySQL dialect. The MySQL keyword set MUST include MySQL-specific constructs such as `LIMIT`, `OFFSET`, `JOIN`, `UNION`, `INSERT IGNORE`, `ON DUPLICATE KEY UPDATE`, `ENGINE`, `CHARSET`, `COLLATE`, `STRAIGHT_JOIN`, `USE`, `REPLACE`, `LOCK IN SHARE MODE`, `FOR UPDATE`, etc.

2. **Schema source** — `schemaCompletionSource({ dialect: MySQL, schema: namespace })` from `@codemirror/lang-sql`, where `namespace` is built from `mysqlSchemaCache.getNamespace(connection_id)`. This source MUST canonically handle:
   - Qualified names (`<schema>.<partial>`) by anchoring `from` immediately after the dot and filtering only the partial — no greedy capture of the schema portion.
   - Default-schema unqualified table completion (when the active connection has a current `USE`d database).
   - FROM-clause aware column scoping: when the editor's parse tree shows `SELECT ... FROM users u`, completing `u.` MUST suggest only the columns of `users` (sourced from `mysql-columns-cache`).
   - CTE awareness (MySQL 8+): tables declared in `WITH name AS (...)` MUST be available as completions in the body of the same statement.

3. **Document identifier source** — a custom source that walks the editor's syntax tree (via `syntaxTree(state)` from `@codemirror/language`) and extracts:
   - CTE names declared in `WITH ... AS (...)` clauses.
   - Aliases declared in `FROM <table> [AS] <alias>` and `JOIN <table> [AS] <alias>` clauses.
   - Other identifiers that appear in `FromClause` / `JoinClause` positions.
   This source MUST NOT use raw regex to identify these tokens — it MUST use the parser's syntax tree so that strings, comments, and backtick identifiers are correctly excluded.

The schema source's column suggestions MUST consume the `mysql-columns-cache` (specified in a sibling capability) — when a relation's columns are not yet cached, the source MUST trigger a fetch via the cache's normal lazy-load contract and offer keyword-only / document-only completions until the cache resolves.

The editor MUST keep the `sql({ dialect: MySQL })` language configuration in a separate `Compartment` from `autocompletion`, so that reconfiguring the autocomplete sources (when the schema cache changes) does NOT re-instantiate the language or invalidate the syntax tree / highlighting / indent logic.

When `mysqlSchemaCache` notifies of a change, the editor MUST reconfigure the autocomplete `Compartment` to re-bind `schemaCompletionSource` to the new namespace, debounced 100ms. If the new namespace is shape-equal to the previous (same schema names with same relation name sets), the reconfigure MUST be skipped to avoid editor churn.

When neither schemas, relations, nor columns are loaded for the current connection, the editor MUST still function and offer **keyword-only completion** plus document identifiers found in the current buffer.

#### Scenario: Keywords always complete

- **WHEN** the editor is empty and the user types `SEL`
- **THEN** the autocomplete popup opens with `SELECT` as a top suggestion
- **AND** the suggestion has type `keyword`

#### Scenario: MySQL-specific keywords are available

- **WHEN** the editor contains `INSERT INTO `t` VALUES (1) ON DUP`
- **THEN** the autocomplete popup includes `DUPLICATE KEY UPDATE` (or `ON DUPLICATE KEY UPDATE`) as a suggestion

#### Scenario: Qualified name completion is canonical

- **WHEN** the schema cache contains `app.users`, `app.orders`, `analytics.events`
- **AND** the user types `SELECT * FROM app.us`
- **THEN** the autocomplete popup shows `users` (and any other `app.*` relations matching `us`) as the top suggestion
- **AND** the popup does NOT consume the `app.` portion as part of the typed prefix — only `us` is the partial

#### Scenario: Alias-aware column completion via columns cache

- **WHEN** the document is `` SELECT u. FROM `app`.`users` u `` with the cursor right after `u.`
- **AND** `mysql-columns-cache` has columns for `app.users`
- **THEN** the autocomplete popup suggests every column of `app.users` (e.g. `id`, `email`, `created_at`)
- **AND** does NOT suggest columns of unrelated relations

#### Scenario: CTE name appears in completion

- **WHEN** the document is `WITH recent AS (SELECT * FROM events) SELECT * FROM rec`
- **AND** the cursor is right after `rec`
- **THEN** the autocomplete popup includes `recent` as a suggestion (sourced from the document identifier source)
- **AND** the suggestion's `detail` indicates it is a CTE

#### Scenario: Cache update reconfigures autocomplete without breaking the editor

- **WHEN** a new schema `analytics` is bulk-loaded into the cache while a query tab is open
- **THEN** within ~100ms the editor's autocomplete reflects the new schema (typing `FROM analytics.` shows its relations)
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

Each `mysql-query` tab SHALL render a result panel below the editor. The panel MUST:

- Render a hint state when no run has occurred yet in this tab. The hint MUST advertise both run and autocomplete shortcuts so the user discovers them on first use; the recommended copy is `Press ⌘↩ to run · Tab to autocomplete`.
- Render a virtualized read-only data grid (the `<MysqlAdhocResultGrid />` provided by `mysql-data-grid`) for `kind: "rows"` results, displaying the `columns` and `rows` from the response. The grid MUST support row selection that drives the shell's right inspector (when the inspector is expanded). Column widths inside the grid MUST default to the type-derived base widths defined by `column-width-preferences` and MUST be user-resizable; resizing MUST NOT persist to disk across runs or sessions, but MUST persist within the same `<MysqlAdhocResultGrid />` instance for as long as the columns prop shape is unchanged.
- Render a compact summary line for `kind: "affected"` results: `<command_tag> · <affected_rows> rows affected · <query_ms> ms`. Example: `INSERT · 3 rows affected · 12 ms`.
- Display a banner above the grid `Result truncated at 10,000 rows — add a LIMIT clause to refine.` whenever the response has `truncated: true`.

The panel's height MUST be resizable via a drag handle on its top edge (between editor and panel) within bounds 120–800px; the height MUST persist per tab id under settings key `mysqlQueryResultHeight:<tab_id>` while the tab exists.

#### Scenario: Empty state on fresh tab advertises run + autocomplete

- **WHEN** a `mysql-query` tab is opened and no run has been executed
- **THEN** the panel shows the hint `Press ⌘↩ to run · Tab to autocomplete`
- **AND** no grid is rendered

#### Scenario: Rows result renders the adhoc grid

- **WHEN** a SELECT returns 50 rows with 4 columns
- **THEN** the panel renders a `<MysqlAdhocResultGrid />` with those 50 rows and 4 columns
- **AND** clicking a row populates the shell's right inspector with that row's column-value list

#### Scenario: Affected result renders the compact summary

- **WHEN** an INSERT returns `{ kind: "affected", command_tag: "INSERT", affected_rows: 3, query_ms: 12 }`
- **THEN** the panel shows `INSERT · 3 rows affected · 12 ms`
- **AND** no grid is rendered

#### Scenario: Truncation banner surfaces above the grid

- **WHEN** a SELECT returns 10,000 rows with `truncated: true`
- **THEN** a banner reads `Result truncated at 10,000 rows — add a LIMIT clause to refine.` above the grid

#### Scenario: Adhoc grid column widths reset when columns prop changes

- **WHEN** the user runs `` SELECT id, email FROM `app`.`users` ``, resizes `email` to 320px, then runs `` SELECT id, email, status FROM `app`.`users` `` in the same tab
- **THEN** the new result re-renders the grid with `id`, `email`, and `status` at their type-derived base widths
- **AND** the previous 320px override for `email` is discarded

### Requirement: Error block with SQLSTATE and position

When a run results in `AppError::Mysql { code, message, position }` or `AppError::Validation { message }`, the result panel MUST render an error block in `var(--danger)` that displays:

- The error message verbatim, with `connection is read-only` prepended (followed by `: `) when the underlying server error has SQLSTATE `25006`.
- The SQLSTATE code in monospace (when present).
- An inline `Show in editor` button when `position` is present; activating it MUST move the editor's cursor to `position - 1` (CodeMirror is 0-based) within the most recently executed SQL and place a red wavy underline decoration at the character range starting at that offset (extending to the next whitespace or to the next 32 characters, whichever is shorter).

The renderer MUST translate the 1-based character `position` to a line/column for visual display next to the error message (`Line N, Col M`). The translation uses the source SQL text the user actually ran (the selected text, the statement under cursor, or the full document for run-all).

For multi-statement runs, the failing statement's index MUST be shown as `Statement <i>` (1-based) and clicking `Show in editor` MUST move the cursor to `statement.start_offset + position - 1` so the cursor lands at the actual error location in the source document. The red underline decoration MUST be placed at the corresponding range in the source document, not in the (now hidden) failing statement substring.

The error decoration MUST clear as soon as the user types anywhere in the editor.

#### Scenario: Single-statement syntax error renders inline error

- **WHEN** the user runs `SELEC 1`
- **THEN** the panel renders an error block with the MySQL message, SQLSTATE `42000`, `Line 1, Col 1`, and a `Show in editor` button
- **AND** activating `Show in editor` moves the cursor to character 0 (position 1 - 1) of the editor

#### Scenario: Error underline is drawn at the failure position

- **WHEN** an error reports `position: 5` for the SQL `SELEC 1`
- **THEN** the editor draws a red wavy underline starting at character index 4 (0-based), extending through `SELEC`
- **AND** typing anywhere clears the underline

#### Scenario: Multi-statement failing index is labeled and shows in editor

- **WHEN** a run-many produces `[ok, err, skipped]`, the failing entry has `index: 1`, `position: 8`, and the second statement starts at offset 12 in the source document
- **THEN** the panel renders the error block prefixed with `Statement 2`
- **AND** the `Show in editor` button moves the cursor to offset `12 + 8 - 1 = 19` in the editor
- **AND** the red underline is placed starting at offset 19

#### Scenario: Read-only SQLSTATE 25006 prepends the friendly message

- **WHEN** a run fails with `AppError::Mysql { code: Some("25006"), message: "Cannot execute statement in a READ ONLY transaction.", ... }`
- **THEN** the error block's first line reads `connection is read-only: Cannot execute statement in a READ ONLY transaction.`
- **AND** the SQLSTATE `25006` is shown in monospace beneath the message

### Requirement: Multi-statement result sub-tabs

When a run returns more than one statement outcome (i.e. `mysql_run_sql_many` was invoked), the result panel MUST render sub-tabs (one per statement) in document order. Each sub-tab's label MUST follow the pattern `<i> · <summary>` where `<i>` is the 1-based statement index and `<summary>` is:

- `<row_count> rows` for `kind: "rows"`.
- The `command_tag` for `kind: "affected"` (e.g. `INSERT`, `UPDATE`, `CREATE TABLE`).
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

### Requirement: Bottom status indicator

Each `mysql-query` tab SHALL display a status indicator inside the tab's chrome (between editor and result panel, or in the panel header). The indicator MUST show: the latest run's elapsed time (`12 ms`) and the latest run's outcome summary (`5 rows`, `3 rows affected`, or `error`). When a run is in flight, the indicator MUST show the live elapsed-time text per the "Live elapsed-time indicator while running" requirement (i.e. `Running…` for the first second, then `Running… <s>s` up to a minute, then `Running… <m>:<ss>` past one minute).

#### Scenario: Indicator updates after a successful run

- **WHEN** a SELECT completes returning 5 rows in 12 ms
- **THEN** the indicator reads `5 rows · 12 ms`

#### Scenario: Indicator shows running state with live elapsed time

- **WHEN** a run has been in flight for 2300ms and the response has not yet arrived
- **THEN** the indicator reads `Running… 2.3s`
- **AND** the text continues to tick approximately every 100ms until the run completes

### Requirement: In-session SQL buffer persistence

Each `mysql-query` tab SHALL persist its SQL document under settings key `mysqlQueryBuffer:<tab_id>` with a debounce of 500ms after the last keystroke. On tab mount, the editor MUST read this key and initialize its document from it (or from the tab payload's `sql` field if no setting exists). When the tab closes, the key MUST be removed. The shell does not currently restore tabs across app launches; this requirement only ensures the buffer survives focus changes and refreshes within a single session.

#### Scenario: Buffer survives switching tabs and returning

- **WHEN** the user types `SELECT 42` in a query tab, switches to another tab, and returns to the query tab
- **THEN** the editor still shows `SELECT 42`

#### Scenario: Closing the tab removes the buffer

- **WHEN** the user types into a query tab and then closes it
- **THEN** the settings key `mysqlQueryBuffer:<tab_id>` no longer exists

### Requirement: Read-only banner above the editor

When the active connection has `params.read_only: true`, each `mysql-query` tab against that connection MUST render a banner above the editor reading `Read-only connection — non-SELECT statements will be rejected.` The banner MUST use `var(--accent-soft)` background and an icon. The editor and result panel MUST otherwise function normally (SELECTs run, SHOWs run, EXPLAINs run); only mutations are rejected by the backend.

#### Scenario: Banner appears on read-only connection

- **WHEN** the user opens a query tab against a read-only connection
- **THEN** the banner is visible above the editor

#### Scenario: SELECT still runs on read-only connection

- **WHEN** the user runs `SELECT 1` on the read-only tab
- **THEN** the result panel renders the row normally with no error

### Requirement: Tab close discards buffer without confirm

Closing a `mysql-query` tab via `Mod-W` or the tab's close button MUST close the tab immediately and remove its `mysqlQueryBuffer:<tab_id>` setting. No confirmation dialog MUST be shown, even if the document is non-empty (the dirty-state confirmation in "Dirty state tracking and unsaved-changes confirmation" applies only to tabs bound to a saved query). Rationale: SQL in the editor is not yet committed to the database; losing it is not as costly as losing a dirty edit buffer.

#### Scenario: Close drops the buffer with no prompt

- **WHEN** the user has typed `SELECT 1` and presses `Mod-W` on the query tab (with no `saved_query_id`)
- **THEN** the tab closes immediately
- **AND** no confirmation dialog appears
- **AND** the `mysqlQueryBuffer:<tab_id>` key is removed

### Requirement: Prefilled SQL survives StrictMode mount race

When a `mysql-query` tab opens with a non-empty `payload.sql` (for example, via the data viewer's `Open in SQL Editor` action), the editor MUST mount with `payload.sql` as its initial document, on every code path — including under React 18 `<React.StrictMode>` dev double-mount.

The in-session SQL buffer cleanup ("closing a tab discards the buffer") MUST be tied to the actual tab-close gesture (the close-handler registry consulted by `TabStrip`), NOT to React unmount alone. A StrictMode replay (mount → cleanup → mount on the same tab) MUST NOT clobber the buffer with the empty string between the first mount's seeding and the second mount's read.

#### Scenario: Open in SQL Editor lands on the prefilled SQL in dev

- **WHEN** the user clicks `Open in SQL Editor` from a MySQL table viewer that has a non-empty applied filter
- **AND** the app is running with `<React.StrictMode>` enabled (dev mode)
- **THEN** the new query tab's editor mounts with the SQL produced by `compileMysqlPrefilledSelect` (`` SELECT * FROM `schema`.`table` WHERE ... LIMIT N ``) as its initial document
- **AND** the editor never displays an empty document for the lifetime of the tab

#### Scenario: Open in SQL Editor lands on the prefilled SQL in prod

- **WHEN** the user clicks `Open in SQL Editor` in production (no StrictMode replay)
- **THEN** the editor mounts with the same `compileMysqlPrefilledSelect` output

#### Scenario: Closing a query tab still removes the buffer

- **WHEN** the user closes a `mysql-query` tab via the close button or `Mod-W`
- **THEN** the `mysqlQueryBuffer:<tab_id>` settings key is removed
- **AND** no confirmation dialog is shown (when the tab has no saved-query binding)

### Requirement: Run commands persist a query-history row per executed statement

In the SAME execution path where `mysql_run_sql` emits its `argus:activity-log` event AND for each successfully-executed step of `mysql_run_sql_many` (one history row per executed step, plus one row for the first errored step in a multi-run), the platform MUST persist a row to the `query_history` SQLite table per the `query-history` capability — exactly one row per executed statement. This includes failed statements (`status: "err"`) and excludes statements that were skipped because an earlier statement failed in a multi-run.

The persistence MUST happen before the run command returns to the frontend, MUST run on the same Tauri command thread (no async task spawn), and MUST NOT mask the SQL execution outcome: any error from the `query_history` insert MUST be logged to stderr but MUST NOT propagate as the command's response. The user-visible behavior of `mysql_run_sql` and `mysql_run_sql_many` (return shape, activity-log events, read-only enforcement, row cap, timeouts) is otherwise unchanged.

The persisted row's fields are owned by the `query-history` capability spec; this requirement only fixes the trigger point, the dialect tag (`mysql`), and the 1:1 correspondence with executed statements. Each history row MUST carry `(connection_id, dialect: "mysql", sql, ran_at, status, duration_ms, error_code?, error_message?, origin)`.

#### Scenario: Each successful run produces one history row

- **WHEN** the user invokes `mysql.runSql(id, "SELECT 1", "user")` against a writable connection
- **THEN** the count of `query_history` rows increases by exactly 1
- **AND** that row's `sql` is `"SELECT 1"`, `status` is `"ok"`, `origin` is `"user"`, `dialect` is `"mysql"`

#### Scenario: Each failed run still produces one history row

- **WHEN** the user invokes `mysql.runSql(id, "SELEC 1", "user")` and MySQL returns SQLSTATE `42000`
- **THEN** the count of `query_history` rows increases by exactly 1
- **AND** that row has `status: "err"`, `error_code: "42000"`, `dialect: "mysql"`

#### Scenario: Run-many writes one row per executed step, none for skipped

- **WHEN** the user invokes `mysql.runSqlMany(id, ["SELECT 1", "SELEC 2", "SELECT 3"], "user")`
- **THEN** the count of `query_history` rows increases by exactly 2 (one ok, one err)
- **AND** no row is written for the third (skipped) statement

#### Scenario: Run-many with all successes writes one row per statement

- **WHEN** the user invokes `mysql.runSqlMany(id, ["SELECT 1", "SELECT 2", "SELECT 3"], "user")`
- **THEN** the count of `query_history` rows increases by exactly 3, each with `status: "ok"` and `dialect: "mysql"`

#### Scenario: A failure to persist history does not fail the run

- **WHEN** the SQL execution succeeds but the subsequent `query_history` insert fails (for example, SQLite is locked)
- **THEN** the run command still returns the successful `RunSqlResult` to the frontend
- **AND** an error is logged to stderr describing the persistence failure

### Requirement: MySQL server message surfaces verbatim in error envelope

When the backend converts a `mysql_async::Error` (or equivalent driver error) into `AppError::Mysql`, the `MysqlErrorBody.message` field MUST carry the **MySQL-server-supplied** error message — not the driver's top-level `Display` string. Specifically:

- When the driver reports a server error with a `code` (SQLSTATE) and a `state`/`message` payload, the `message` field MUST be the server's message string verbatim (e.g. `"Unknown column 'foo' in 'field list'"`).
- The `code` field MUST be the 5-character SQLSTATE extracted from the server error.
- The `position` field MUST be derived by:
  1. Looking for the substring `at line N` in the server message (1-based line number).
  2. Looking for `near '<token>'` to find the offending token.
  3. Computing the character offset of `<token>` on line `N` of the **source SQL** (the actual string the user submitted) and returning a 1-based character offset.
  4. If either anchor is missing, `position` MUST be `None`.
- When the driver reports a transport, protocol, or I/O error with no server-side payload, the `message` field MUST fall back to the driver error's `Display` string, `code` MUST be `None`, and `position` MUST be `None`.

The wire shape of `AppError::Mysql` (`{ kind: "Mysql", message: { code, message, position } }`) is unchanged across drivers. Only the contents of the inner fields change. This requirement applies to every Tauri command that converts a MySQL driver error via the standard `From` impl, including `mysql_run_sql`, `mysql_run_sql_many`, structured-edit, structured-filter, and schema/columns commands.

#### Scenario: Unknown column surfaces server message

- **WHEN** the user runs `` SELECT foo FROM `app`.`users` `` and MySQL rejects it because `foo` does not exist
- **THEN** `AppError::Mysql.message.code` is `"42S22"`
- **AND** `AppError::Mysql.message.message` is exactly `"Unknown column 'foo' in 'field list'"` (the verbatim server message)
- **AND** the SQL editor's error block renders that message verbatim

#### Scenario: Position is computed from "near 'X' at line N"

- **WHEN** MySQL reports `"You have an error in your SQL syntax; ... near 'SELEC 1' at line 2"` for the source SQL `\nSELEC 1`
- **THEN** `AppError::Mysql.message.position` is `Some(2)` (the 1-based character offset of `S` in `SELEC` within the source)
- **AND** the editor underlines the `SELEC` token in the editor at that offset

#### Scenario: Server message without parseable position has position None

- **WHEN** MySQL returns `"Table 'app.missing' doesn't exist"` (no `at line N` anchor)
- **THEN** `AppError::Mysql.message.position` is `None`
- **AND** the error block does not render a `Show in editor` button

#### Scenario: Transport errors preserve driver diagnostic text

- **WHEN** a query fails because the connection was closed mid-flight (a driver error with no server payload)
- **THEN** `AppError::Mysql.message.message` falls back to the driver error's `Display` string (e.g. `"connection closed"`)
- **AND** `AppError::Mysql.message.code` is `None`
- **AND** `AppError::Mysql.message.position` is `None`

#### Scenario: Activity log and query history pick up the server message

- **WHEN** a SQL run fails with a MySQL server error
- **THEN** the `argus:activity-log` event's `error.message` is the same server-message-derived string surfaced to the SQL editor
- **AND** the corresponding `query_history` row's `error_message` column is that same string
- **AND** the `error_code` column is the SQLSTATE

### Requirement: Format SQL action

Each `mysql-query` tab SHALL render a thin toolbar at the top of the editor area containing a `Format` button. The editor SHALL also bind `Mod-Shift-F` to the same action at `Prec.highest` so it cannot be intercepted by other extensions. When invoked:

- The action MUST run the entire editor document through the project's `formatSql(input: string, dialect: "mysql"): string` helper, which MUST wrap `sql-formatter` configured with `{ language: "mysql", keywordCase: "upper", identifierCase: "preserve", dataTypeCase: "upper", functionCase: "lower", indentStyle: "standard", tabWidth: 2, expressionWidth: 80, linesBetweenQueries: 1 }`.
- The action MUST replace the editor document with the formatted output via a single CodeMirror transaction so undo restores the pre-format text in one step.
- After replacement, the cursor MUST be set to offset 0 and the view scrolled to the top.
- If the document is empty or contains only whitespace, the action MUST be a no-op (no transaction dispatched, no error).
- If `sql-formatter` throws (malformed SQL it cannot tokenize), the editor MUST leave the document untouched and surface a non-blocking error toast `Could not format SQL`. The original buffer MUST NOT be lost.

The `Format` button MUST display the keyboard shortcut hint `⌘⇧F` (or `Ctrl+Shift+F` on non-Mac) inline with the label so users discover the binding.

#### Scenario: Format button reformats the buffer

- **WHEN** the editor contains `` select id,name from `app`.`users` where id=1 ``
- **AND** the user clicks the `Format` button
- **THEN** the editor document becomes a multi-line formatted version with `SELECT` and `FROM` uppercased, fields aligned, 2-space indentation, and backtick identifiers preserved
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

- **WHEN** the editor contains text the formatter cannot tokenize (e.g. an unclosed backtick identifier)
- **AND** the user clicks `Format`
- **THEN** the editor document is unchanged
- **AND** a toast appears reading `Could not format SQL`

### Requirement: Live elapsed-time indicator while running

While a run is in flight, the result header's summary slot SHALL display a live elapsed time that updates at 100ms intervals. The text MUST follow these rules, where `ms` is the elapsed time since the run started in the client:

- `ms < 1000` → `Running…`
- `1000 ≤ ms < 60000` → `Running… <s>s` where `<s>` is the elapsed seconds with one decimal (e.g. `Running… 1.2s`, `Running… 12.4s`)
- `ms ≥ 60000` → `Running… <m>:<ss>` where `<m>` is whole minutes and `<ss>` is two-digit seconds (e.g. `Running… 1:23`, `Running… 10:05`)

The interval MUST live on the result header component only (not in `useMysqlQueryRun` or any parent), so re-renders triggered by the tick MUST NOT re-render the editor, the grid, or any sibling tab. The interval MUST be cleared when the result-header component unmounts and when the run completes.

`useMysqlQueryRun` SHALL expose `run_started_at: number | null` (the `Date.now()` at which the most recent run transitioned to `running`, or `null` while idle/done) so the header can compute elapsed time without recreating the timer source.

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

### Requirement: Cancellation via KILL QUERY

Each `mysql-query` tab SHALL render a `Cancel` button next to the live elapsed-time indicator while a run is in flight. Clicking the button OR pressing `Mod-.` (Mac) / `Ctrl-.` (other) MUST invoke a Tauri command `mysql_cancel_run(connection_id, server_connection_id)` that:

1. Opens a fresh short-lived MySQL connection to the same host/port/user/database as the target connection, using the **same `ssl_mode`** as the target (so a TLS-required server is reachable).
2. Executes `KILL QUERY <server_connection_id>` where `<server_connection_id>` is the MySQL server-side `CONNECTION_ID()` recorded on the pooled connection at the start of the run.
3. Closes the short-lived connection.

The frontend MUST record the `CONNECTION_ID()` of the pooled connection at run start (the backend MUST return it as part of an interim `run_started` event or by storing it on the in-flight run record returned by a `mysql_get_running_run` query). The cancel call MUST be fire-and-forget — the frontend MUST NOT wait for the kill to succeed before clearing the indicator; the cancel UX is "submitted" the moment the cancel command returns.

When a `KILL QUERY` succeeds, the in-flight run typically returns to the runner as a `mysql_run_sql` error with SQLSTATE `70100` (`Query execution was interrupted`). The runner MUST treat SQLSTATE `70100` as a cancellation outcome and the result panel MUST render `Cancelled.` instead of the standard error block.

#### Scenario: Cancel button cancels the run

- **WHEN** a query has been running for 4 seconds and the user clicks `Cancel`
- **THEN** `mysql_cancel_run(connection_id, <server_connection_id>)` is invoked
- **AND** the original `mysql_run_sql` returns an error with `code: "70100"`
- **AND** the result panel renders `Cancelled.` instead of an error block

#### Scenario: Cancel shortcut works on Mac and other platforms

- **WHEN** the user presses `Mod-.` while a run is in flight
- **THEN** the cancel handler fires exactly once
- **AND** the editor's document is unchanged

#### Scenario: Cancel uses the same ssl_mode as the original connection

- **WHEN** the target connection uses `ssl_mode: "require"` and a cancel is triggered
- **THEN** the short-lived kill connection is opened with `ssl_mode: "require"`
- **AND** the `KILL QUERY` succeeds against a TLS-only server

#### Scenario: Cancel on an already-finished run is a no-op

- **WHEN** the user clicks `Cancel` but the run has already completed in the same tick
- **THEN** the cancel command MAY still execute the `KILL QUERY` (it is harmless on a finished query)
- **AND** the result panel renders the completed result, not `Cancelled.`

### Requirement: Per-tab timeout selector

Each `mysql-query` tab SHALL render a `Timeout: <Ns>` dropdown in the editor toolbar (to the right of the connection selector). The dropdown MUST list the values `15s` (default), `30s`, `45s`, and `60s`. The selected timeout MUST be sent as a per-call argument to `mysql_run_sql(connection_id, sql, origin, timeout_ms)` and to `mysql_run_sql_many(connection_id, statements, origin, timeout_ms)`. The backend MUST enforce this as the per-statement timeout (for `mysql_run_sql`) or the per-statement timeout within a 30s total cap (for `mysql_run_sql_many` — the run-wide 30s cap is unchanged regardless of the per-statement timeout selection).

The selected timeout MUST persist per tab id under settings key `mysqlQueryTimeoutMs:<tab_id>` while the tab exists. It MUST NOT persist across app launches.

#### Scenario: Default timeout is 15 seconds

- **WHEN** a new query tab is opened
- **THEN** the timeout dropdown reads `Timeout: 15s`
- **AND** invocations of `mysql_run_sql` pass `timeout_ms: 15000`

#### Scenario: Raised timeout is honored

- **WHEN** the user selects `Timeout: 60s` and runs a statement that takes 45 seconds
- **THEN** `mysql_run_sql` is invoked with `timeout_ms: 60000`
- **AND** the statement completes normally without a `70100` cancellation

#### Scenario: Run-many still capped at 30s total

- **WHEN** the user selects `Timeout: 60s` and presses `Mod-Shift-Enter` on a batch whose statements collectively exceed 30 seconds
- **THEN** the in-flight statement returns an `outcome: "err"` with `code: "70100"` and message containing `"run timeout"` when 30 seconds elapse
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
  - integer/decimal/floating-point types (`TINYINT`, `SMALLINT`, `MEDIUMINT`, `INT`, `BIGINT`, `DECIMAL`, `FLOAT`, `DOUBLE`) → numeric cell when the parsed `Number` is finite, else string.
  - `BOOL` / `BOOLEAN` (and `TINYINT(1)` if the connection's `tinyint_as_bool` flag is on) → boolean cell.
  - `DATE`/`DATETIME`/`TIMESTAMP` types → `Date` cell when `new Date(value)` is not `NaN`, else string.
  - `JSON` → string cell containing `JSON.stringify(value)`.
  - `BLOB`/`BINARY`/`VARBINARY` → string cell rendered as `0x<hex>` truncated to 32 characters (or empty for null).
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

- **WHEN** the result has columns `id (INT)`, `is_active (TINYINT(1) as BOOL)`, `display_name (VARCHAR)`, `meta (JSON)` and a row `[7, true, null, {"k":"v"}]`
- **AND** the user chooses `Export as JSONL`
- **THEN** that line of the file is `{"id":7,"is_active":true,"display_name":null,"meta":{"k":"v"}}`

#### Scenario: XLSX export types numeric and date cells

- **WHEN** the result has a column `created_at` of type `DATETIME` with value `"2026-05-06 12:00:00"` and a column `n` of type `INT` with value `42`
- **AND** the user chooses `Export as Excel (.xlsx)`
- **THEN** the written workbook's `Result` sheet has the `created_at` cell as a Date and the `n` cell as a Number (not strings)

#### Scenario: Truncated result exports with marker filename

- **WHEN** a SELECT returns 10000 rows with `truncated: true` and the user chooses `Export as CSV`
- **THEN** the save dialog's default filename ends with `_truncated.csv`
- **AND** the written file contains exactly 10000 data rows plus the header

#### Scenario: User cancels the save dialog

- **WHEN** the user chooses any export format and cancels the save dialog
- **THEN** no file is written and no toast appears

#### Scenario: Export reflects connection name in filename

- **WHEN** the active connection's name is `local-mysql` and the time is `2026-05-06 14:30:05`
- **AND** the user chooses `Export as JSONL` on a non-truncated result
- **THEN** the save dialog's default filename is `local-mysql_query_20260506_143005.jsonl`

### Requirement: Connection selector in editor toolbar

Each `mysql-query` tab SHALL render a connection selector control as the leftmost element of the editor toolbar (the same toolbar that hosts `Format` and `Save`). The selector MUST:

- Display the name of the currently-selected connection along with a status dot reusing the status visualization from the Connections sidebar (e.g. green when connected, gray when disconnected). When no connection is selected, the trigger shows the placeholder `Select connection…`.
- Open a dropdown listing every MySQL connection registered in the connection registry, ordered the same way as the Connections sidebar (groups respected). Each item shows the connection name and the same status dot.
- On selection, update the tab's `current_connection_id` and `current_connection_name` in `useMysqlQueryTabState`.

Switching connections MUST:

1. Reconfigure the autocomplete `Compartment` of the editor to re-bind `schemaCompletionSource` to `mysqlSchemaCache.getNamespace(new_connection_id)`, following the same debounce and shape-equality skip rules already specified in "Schema-aware autocomplete from in-memory cache".
2. Discard the current `runner.state` (any prior result was bound to the previous connection). The result panel reverts to the empty hint state.
3. NOT mark the tab as dirty (the saved query record does not track connection).
4. When `state.saved_query_id` is set, persist the new `current_connection_id` to the saved query's `last_connection_id` via `saved_queries_update`, debounced 1000ms, fire-and-forget.

When the user invokes Run (`Mod-Enter`, `Mod-Shift-Enter`) with no connection selected, the frontend MUST surface a toast `Select a connection first.` and MUST NOT invoke `mysql_run_sql` or `mysql_run_sql_many`.

The selector's connection list MUST reactively update when connections are added, removed, renamed, or change connection state. The selector MUST only list connections whose `dialect: "mysql"` — Postgres connections MUST NOT appear in a `mysql-query` tab's selector.

#### Scenario: Selector reflects current connection with status dot

- **WHEN** the tab's current connection is `prod_db` (MySQL) and it is connected
- **THEN** the selector trigger displays `prod_db` with a green status dot

#### Scenario: Selector excludes non-MySQL connections

- **WHEN** the registry contains two MySQL connections and one Postgres connection
- **THEN** the `mysql-query` tab's selector dropdown lists only the two MySQL connections

#### Scenario: Changing connection re-binds autocomplete

- **WHEN** the user has the editor open with `prod_db` selected and types `` SELECT * FROM `app`. `` to confirm completions reflect `prod_db` schema
- **AND** the user changes the selector to `staging_db`
- **THEN** within ~100ms typing `` SELECT * FROM `app`. `` shows completions from `staging_db`'s schema cache (or empty if not loaded)
- **AND** the editor's syntax highlighting, undo history, and cursor are preserved

#### Scenario: Changing connection clears the result panel

- **WHEN** a result is displayed from a SELECT against `prod_db`
- **AND** the user changes the selector to `staging_db`
- **THEN** the result panel reverts to the empty hint state (`Press ⌘↩ to run · Tab to autocomplete`)
- **AND** the tab is NOT marked dirty by the connection change

#### Scenario: Run with no connection selected is rejected client-side

- **WHEN** the tab has no current connection and the user presses `Mod-Enter` with non-empty SQL
- **THEN** a toast `Select a connection first.` appears
- **AND** neither `mysql_run_sql` nor `mysql_run_sql_many` is invoked

#### Scenario: Selector persists last_connection_id for saved query

- **WHEN** a tab has `state.saved_query_id = "abc"` and the user changes the connection to `staging_db`
- **THEN** within ~1 second `saved_queries_update({ id: "abc", last_connection_id: "<staging_db uuid>" })` is invoked
- **AND** the tab is NOT marked dirty

### Requirement: Save action in editor toolbar

Each `mysql-query` tab SHALL render a `Save` button in the editor toolbar (to the right of the connection selector, before `Format`). The editor SHALL also bind `Mod-S` to the same action at `Prec.highest` so it cannot be intercepted by other extensions or browser defaults.

Saved MySQL queries participate in the `saved-queries` capability with `kind: "mysql"`. When invoked, the action MUST:

- **First save (no `state.saved_query_id`)**: open a modal `SaveAsModal` with two fields — `Name` (text input, required, pre-filled with the tab title if non-default) and `Folder` (a tree picker of `saved_query_folders`, defaulting to the value stored in settings key `savedQueries:lastUsedFolder` or root if unset). The modal MUST provide a `+ New folder…` affordance that inline-creates a child folder under the current selection. On confirm:
  1. Invoke `saved_queries_create({ folder_id, name, kind: "mysql", sql: <current editor text>, last_connection_id: <current connection id or null> })`.
  2. Update tab state: `saved_query_id = record.id`, `saved_sql = record.sql`, `saved_name = record.name`, `saved_folder_id = record.folder_id`. Set `tab.title = record.name`.
  3. Persist `savedQueries:lastUsedFolder = folder_id` in settings.
  4. Surface a brief success toast `Saved as "<name>"`.

- **Subsequent saves (`state.saved_query_id` present)**: directly invoke `saved_queries_update({ id, name: <state.edited_name ?? saved_name>, sql: <current editor text> })`. No modal. On success, update `saved_sql` and `saved_name` to the new values and bump the tab title if the name changed. Surface a brief toast `Saved`.

The action MUST be a no-op (silent, no toast, no command) if the tab is not dirty (current SQL and name equal the saved snapshot). The action MUST still be invokable when the editor is empty (an empty saved query is valid).

#### Scenario: First save opens the modal

- **WHEN** the user has a new tab with `SELECT 1` typed and no `saved_query_id`
- **AND** the user presses `Mod-S`
- **THEN** a `SaveAsModal` appears with Name pre-filled, Folder defaulting to the last used folder
- **AND** confirming with name `Test` invokes `saved_queries_create` with `{ name: "Test", kind: "mysql", sql: "SELECT 1", folder_id, last_connection_id }`
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

Each `mysql-query` tab SHALL track a `dirty: boolean` derived from:

- For tabs with `state.saved_query_id`: `dirty = (current_sql !== saved_sql) || (current_name !== saved_name)`.
- For tabs without `state.saved_query_id`: `dirty = current_sql.trim().length > 0`.

The dirty state MUST surface visually as a leading `●` character before the tab title in the tab strip. The tooltip on the dirty indicator MUST read `Unsaved changes`.

Changing the current connection MUST NOT affect `dirty`. Successfully running the query MUST NOT clear `dirty`. Only a successful `Save` (or reverting edits to match the saved snapshot) clears `dirty`.

When the user attempts to close a `dirty` tab via `Mod-W` or the tab close button:

- If the tab has `state.saved_query_id`: show a confirmation dialog `Discard unsaved changes to "<name>"?` with buttons `Discard` (destructive) and `Cancel` (default). Only `Discard` proceeds with closing.
- If the tab has NO `state.saved_query_id` (never-saved scratch buffer with content): close immediately without prompt (preserves the existing "Tab close discards buffer without confirm" behavior for ad-hoc queries).

After closing in either case, the `mysqlQueryBuffer:<tab_id>` settings key MUST still be removed per the existing requirement.

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
- **AND** clicking `Discard` closes the tab and removes the `mysqlQueryBuffer:<tab_id>` key

#### Scenario: Closing dirty ad-hoc tab is immediate

- **WHEN** a tab has no `state.saved_query_id` and is dirty (non-empty SQL)
- **AND** the user presses `Mod-W`
- **THEN** the tab closes immediately without a prompt
- **AND** the `mysqlQueryBuffer:<tab_id>` key is removed

### Requirement: SQL identifier rendering uses backticks

Every SQL snippet emitted by the editor or by entry points that route into the editor (e.g. "New Query Here" on a database/schema node, "Insert column reference" from the schema browser, the "Open as SELECT" affordance on a table node, the data viewer's "Open in SQL Editor" action) MUST quote MySQL identifiers with backticks (`` ` ``), NOT double quotes.

Specifically:

- A table reference MUST be rendered `` `schema`.`table` `` when both schema and table are known, or `` `table` `` when only the table is in scope (current `USE`'d database).
- A column reference MUST be rendered as `` `column` `` (or `` `table`.`column` `` when disambiguation against a join is needed).
- The "Open as SELECT" affordance MUST emit exactly `` SELECT * FROM `schema`.`table` LIMIT 100; `` (with a trailing semicolon and a newline-terminating semicolon when concatenated with subsequent statements).
- Internal helpers that escape identifiers MUST escape an embedded backtick by doubling it: `` ` `` → `` `` `` (per MySQL identifier escaping rules).

#### Scenario: Open as SELECT emits backticked identifiers

- **WHEN** the user right-clicks the table `app.users` in the schema browser and selects `Open as SELECT`
- **THEN** a new `mysql-query` tab opens with the editor document `` SELECT * FROM `app`.`users` LIMIT 100; ``

#### Scenario: New Query Here uses current schema

- **WHEN** the user right-clicks the schema node `app` and selects `New Query Here`
- **THEN** a new `mysql-query` tab opens with the connection's current database set to `app` (via an implicit `USE \`app\`` on the pool's next session, or by setting the editor's default schema context) and an empty editor

#### Scenario: Column reference insertion uses backticks

- **WHEN** the user double-clicks the column `email` of the table `app.users` in the schema browser while the editor is focused
- **THEN** the editor inserts the text `` `email` `` at the cursor position

#### Scenario: Identifier with embedded backtick is doubled

- **WHEN** an internal helper renders the identifier `weird\`name` (a backtick inside)
- **THEN** the rendered SQL is `` `weird``name` ``

### Requirement: Query tab result and editor state survive tab switches

A `mysql-query` tab SHALL retain the following in-memory state across any sequence of tab activations and deactivations within the same app session:

- The CodeMirror editor document (already covered by the existing `mysqlQueryBuffer:<tab_id>` persistence requirement, but MUST also be preserved without a settings round-trip on activation).
- The editor's caret position, selection range, scroll position, and undo history.
- The last query result(s) — rows, affected counts, multi-statement sub-tabs, the active sub-tab — for as long as the tab is open.
- Error blocks (SQLSTATE, position, server message) from the most recent failed run.
- The live elapsed-time indicator state for any in-flight run.
- Read-only banner visibility (derived from connection state — must remain consistent on return).
- The per-tab timeout selector value.

Switching away from a query tab and back MUST NOT re-execute the last query, MUST NOT clear the result, and MUST NOT reset the editor selection or scroll position.

A query tab MAY re-execute only in response to the user explicitly running it (the Run shortcut, the Run button, or the statement-under-cursor action).

Closing a query tab MUST discard the retained result and editor state. The existing `Tab close discards buffer without confirm` requirement applies unchanged.

#### Scenario: Query result persists across tab switch

- **WHEN** the user runs `` SELECT * FROM `app`.`users` LIMIT 10 `` in a query tab, observes the result panel, switches to another tab, then returns
- **THEN** the result panel still shows the same 10 rows
- **AND** no `mysql_run_sql` (or equivalent run command) is dispatched as a result of the activation
- **AND** the editor caret is in the same position as before

#### Scenario: Multi-statement sub-tab choice persists

- **WHEN** the user runs three statements and clicks the second result sub-tab, then switches tabs and returns
- **THEN** the second result sub-tab is still active

#### Scenario: Error block persists across tab switch

- **WHEN** the user runs a statement that produces a SQLSTATE error, switches tabs, and returns
- **THEN** the same error block (code, position, server message) is still rendered
- **AND** no automatic re-run occurs

#### Scenario: In-flight run continues while tab is hidden

- **WHEN** the user runs a long query and switches to another tab before it completes
- **THEN** the query continues to execute in the background
- **AND** when the user returns to the query tab, the result is already rendered (or the elapsed-time indicator continues if still running)

#### Scenario: Closing the tab drops the retained result

- **WHEN** the user closes a query tab that had a result rendered
- **THEN** the retained result is released along with the tab's renderer
- **AND** reopening "New Query" creates a fresh tab with an empty editor and no result

