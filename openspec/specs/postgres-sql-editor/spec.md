# postgres-sql-editor Specification

## Purpose
TBD - created by archiving change run-sql. Update Purpose after archive.
## Requirements
### Requirement: Run SQL command (single statement)

The Postgres module SHALL expose a Tauri command `postgres_run_sql(connection_id, sql, origin?)` that executes exactly one SQL statement against the connection's pool and returns a discriminated `RunSqlResult` payload. The `origin` argument MUST be `"user"` or `"auto"` and defaults to `"user"` when absent (this command is always user-driven; defaulting to `"user"` matches the contract). The command MUST acquire a connection from the existing pool registry, MUST NOT open a new connection, and MUST classify the statement via the existing `is_mutating_sql` helper:

- If the statement is non-mutating (SELECT, EXPLAIN, SHOW, VALUES, WITH-only-reads, etc.), it MUST execute through the pool's read-only-aware `execute_query` path.
- If the statement is mutating (INSERT, UPDATE, DELETE, DDL, DO, GRANT, etc.) AND the connection has `params.read_only: true`, the command MUST return `AppError::Validation { message: "connection is read-only" }` BEFORE dispatching the SQL to Postgres.
- Otherwise the statement MUST execute through `execute_mutation`.

The response MUST be one of:

- `{ kind: "rows", columns: Array<ColumnInfo>, rows: Array<Array<Value>>, query_ms: number, truncated_columns: string[], truncated: boolean }` — used when the statement returns a row set (any SELECT, RETURNING, EXPLAIN, etc.). The `columns`, `rows`, and `truncated_columns` fields MUST follow the same shape as `postgres_query_table` (snake_case keys, same `Value` envelope handling for binary/truncated cells). `truncated: true` indicates the row count hit the cap (see "Result row cap").
- `{ kind: "affected", command_tag: string, affected_rows: number, query_ms: number }` — used when the statement returns no rows. `command_tag` MUST be the raw command tag returned by Postgres (e.g. `"INSERT 0 3"`, `"UPDATE 5"`, `"CREATE TABLE"`). `affected_rows` MUST be the rows-affected integer extracted from the tag (0 when not applicable, e.g. for DDL).

The command SHALL emit exactly one `argus:activity-log` event before returning, with `kind: "run_sql"`, `connection_id: <id>`, `origin: <origin argument>`, `sql: <full SQL text>`, `params: null`, `metric: { kind: "rows", value: <returned row count> }` for `kind: "rows"` results, `metric: { kind: "affected", value: <affected_rows> }` for `kind: "affected"` results, `null` on failure, and `status` matching the result.

#### Scenario: SELECT returns rows envelope

- **WHEN** the user invokes `postgres.runSql(id, "SELECT id, name FROM \"public\".\"users\" LIMIT 5", "user")`
- **THEN** the response is `{ kind: "rows", columns: [{ name: "id", … }, { name: "name", … }], rows: [[…], …], query_ms, truncated_columns, truncated: false }`
- **AND** one `argus:activity-log` event is emitted with `kind: "run_sql"`, `status: "ok"`, `metric: { kind: "rows", value: 5 }`, `origin: "user"`, `sql` containing the SELECT, `params: null`

#### Scenario: INSERT returns affected envelope

- **WHEN** the user invokes `postgres.runSql(id, "INSERT INTO \"public\".\"users\" (name) VALUES ('a'), ('b'), ('c')", "user")` against a writable connection
- **THEN** the response is `{ kind: "affected", command_tag: "INSERT 0 3", affected_rows: 3, query_ms }`
- **AND** the activity-log event has `metric: { kind: "affected", value: 3 }`

#### Scenario: DDL returns affected envelope with zero rows

- **WHEN** the user invokes `postgres.runSql(id, "CREATE TABLE foo (id int)", "user")` against a writable connection
- **THEN** the response is `{ kind: "affected", command_tag: "CREATE TABLE", affected_rows: 0, query_ms }`

#### Scenario: Mutation on read-only connection rejected before dispatch

- **WHEN** the user invokes `postgres.runSql(id, "DELETE FROM \"public\".\"users\"", "user")` and the connection has `params.read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }`
- **AND** the SQL is NOT dispatched to Postgres
- **AND** an activity-log event is emitted with `status: "err"`, `error.message` matching the validation message

#### Scenario: SELECT on read-only connection succeeds

- **WHEN** the user invokes `postgres.runSql(id, "SELECT 1", "user")` against a read-only connection
- **THEN** the response is `{ kind: "rows", … }` with one row
- **AND** no validation error is raised

#### Scenario: Origin defaults to user

- **WHEN** the caller invokes `postgres.runSql(id, "SELECT 1")` without supplying `origin`
- **THEN** the activity-log event has `origin: "user"`

#### Scenario: Postgres syntax error includes position

- **WHEN** the user invokes `postgres.runSql(id, "SELEC 1", "user")` (typo)
- **THEN** the command returns `AppError::Postgres { code: Some("42601"), message, position: Some(<1-based offset>) }`
- **AND** an activity-log event is emitted with `status: "err"`, `error.code: "42601"`, `metric: null`

### Requirement: Run multi-statement command

The Postgres module SHALL expose a Tauri command `postgres_run_sql_many(connection_id, statements, origin?)` that executes a list of pre-split SQL statements sequentially on the **same** pool client and returns an array of per-statement outcomes. The `statements` argument MUST be a `Vec<String>` already split by the frontend (the backend MUST NOT re-split). The `origin` argument defaults to `"user"`. The command MUST hold the same client borrowed from the pool across all statements (so that session-scoped statements like `SET search_path` persist across the run) and MUST release the client when the run completes (success, error, or skip).

For each statement the command MUST apply the same classification logic as `postgres_run_sql` (read-only enforcement via `is_mutating_sql`, choice of `execute_query` vs `execute_mutation`). The response MUST be `Array<{ statement_index: number, status: "ok" | "err" | "skipped", result?: RunSqlResult, error?: { message: string, code: string | null, position: number | null } }>`. On the first statement that returns an error:

- That entry MUST have `status: "err"` and the error populated.
- ALL subsequent entries MUST have `status: "skipped"` with no `result` and no `error`.

The command MUST NOT wrap the run in an implicit `BEGIN`/`COMMIT`. Each statement commits on its own (Postgres default for separate statements). If the user wants atomicity, they include `BEGIN` and `COMMIT` as explicit statements.

The command SHALL emit one `argus:activity-log` event PER statement that actually executed (i.e. for each `status: "ok"` and the first `status: "err"`; skipped statements do NOT emit events). Each event MUST follow the same payload shape as `postgres_run_sql`'s event for that single statement.

#### Scenario: Three successful statements emit three events

- **WHEN** the user invokes `postgres.runSqlMany(id, ["SELECT 1", "SELECT 2", "SELECT 3"], "user")`
- **THEN** the response has three entries with `status: "ok"` and `result.kind: "rows"`
- **AND** three `argus:activity-log` events are emitted, each with `kind: "run_sql"`, `status: "ok"`, and the SQL of its corresponding statement

#### Scenario: Failure halts execution and skips remaining

- **WHEN** the user invokes `postgres.runSqlMany(id, ["SELECT 1", "SELEC 2", "SELECT 3"], "user")`
- **THEN** the response is `[{ status: "ok", result: { kind: "rows", … } }, { status: "err", error: { code: "42601", … } }, { status: "skipped" }]`
- **AND** exactly two `argus:activity-log` events are emitted (one ok, one err); none for the skipped statement

#### Scenario: Session settings persist across statements

- **WHEN** the user invokes `postgres.runSqlMany(id, ["SET search_path TO \"analytics\"", "SELECT current_schema()"], "user")` against a writable connection
- **THEN** the second statement returns `"analytics"` as the current schema
- **AND** both entries have `status: "ok"`

#### Scenario: Mutation in middle of multi-run on read-only is rejected at that index

- **WHEN** the user invokes `postgres.runSqlMany(id, ["SELECT 1", "DELETE FROM users", "SELECT 2"], "user")` against a read-only connection
- **THEN** entry 0 has `status: "ok"`, entry 1 has `status: "err"` with the read-only validation error, entry 2 has `status: "skipped"`

### Requirement: Result row cap

`postgres_run_sql` and each step of `postgres_run_sql_many` SHALL cap the returned row set at 10,000 rows. When a query produces more than 10,000 rows, the backend MUST return the first 10,000 in `rows`, MUST set `truncated: true` in the response, and MUST stop fetching further rows from the server (drop the iterator / discard the remainder). The cap is per-statement, not per-run. The `query_ms` MUST measure end-to-end including the time spent fetching the cap-many rows.

#### Scenario: Query returning under cap is not truncated

- **WHEN** a SELECT returns 4,200 rows
- **THEN** the response has `rows.length === 4200` and `truncated: false`

#### Scenario: Query exceeding cap is truncated to 10,000 with marker

- **WHEN** a SELECT against a 1M-row table runs without LIMIT
- **THEN** the response has `rows.length === 10000` and `truncated: true`
- **AND** the activity-log event metric is `{ kind: "rows", value: 10000 }`

### Requirement: Query tab kind

The frontend SHALL register a tab kind `postgres-query` and SHALL render it in the center work area when the user activates a "New Query" entry point (sidebar button, palette command). The tab payload MUST be `{ connectionId: string, connectionName: string, sql: string }`. The tab MUST have an id of the form `pgquery:<connectionId>:<uuid>` where `<uuid>` is a fresh v4 UUID generated on tab creation; activating "New Query" MUST always create a new tab (never focus an existing one). The default tab title MUST be `Query <N>` where `N` is a per-connection running counter starting at 1; the counter resets when the app launches.

#### Scenario: New Query opens a fresh tab

- **WHEN** the user clicks `+ Query` on connection `local-pg`
- **THEN** a center-area tab of kind `postgres-query` opens with payload `{ connectionId, connectionName: "local-pg", sql: "" }` and id `pgquery:<connectionId>:<uuid>`
- **AND** the tab title is `Query 1` (or `Query <N+1>` if other query tabs already exist for that connection)

#### Scenario: Multiple New Query activations create distinct tabs

- **WHEN** the user clicks `+ Query` three times on the same connection
- **THEN** three distinct `postgres-query` tabs open with three different ids and titles `Query 1`, `Query 2`, `Query 3`

### Requirement: CodeMirror editor with Postgres dialect

Each `postgres-query` tab SHALL render a CodeMirror 6 editor with `@codemirror/lang-sql` configured with the `PostgreSQL` dialect. The editor MUST use `Geist Mono` per `DESIGN.md`, render with the app's current theme tokens (`var(--surface)` background, `var(--border)` for the gutter divider, `var(--accent)` for selection), and mount directly via `EditorView` on a `ref`'d `<div>` (no React wrapper around CodeMirror). The editor MUST provide line numbers, syntax highlighting for SQL keywords/strings/comments, bracket matching, multi-cursor support (Mod-D), comment-line toggle (Mod-/), and indentation via Tab / Shift-Tab. The editor MUST take focus on tab open.

The Tab key SHALL behave context-sensitively:

- When the autocomplete popup is open with an active suggestion (`completionStatus(state) === "active"`), Tab MUST accept the highlighted suggestion (equivalent to `acceptCompletion`).
- Otherwise, Tab MUST insert one indent level (`indentMore`).

Shift-Tab MUST always dedent (`indentLess`), regardless of popup state.

#### Scenario: Editor mounts with empty SQL on new tab

- **WHEN** the user opens a `postgres-query` tab for the first time
- **THEN** an empty editor is rendered with focus, line number 1 visible, and the gutter using `var(--border)`

#### Scenario: SQL syntax highlighting is active

- **WHEN** the user types `SELECT id FROM users WHERE id = 1`
- **THEN** `SELECT`, `FROM`, `WHERE` are highlighted as keywords
- **AND** `1` is highlighted as a numeric literal

#### Scenario: Comment toggle works on selection

- **WHEN** the user selects two lines of SQL and presses `Mod-/`
- **THEN** both lines gain a leading `-- ` (or lose it on a second invocation)

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
- Otherwise it MUST run the **statement under the cursor**, where the statement is determined by splitting the editor's full document with a SQL-aware splitter that respects single-quoted strings (`'…'` with `''` escape), double-quoted identifiers (`"…"`), dollar-quoted strings (`$tag$…$tag$` for any tag including the empty tag), single-line comments (`-- … \n`), and nested block comments (`/* … */`). The cursor's offset MUST be matched against the statement ranges; if the cursor sits in whitespace between two statements, the editor MUST run the immediately preceding statement.

The editor SHALL also bind `Mod-Shift-Enter` to "run all" — execute every statement in the document as a multi-statement run, regardless of cursor or selection — also at `Prec.highest`.

When a single statement is to be executed, the frontend MUST invoke `postgres_run_sql`. When two or more statements are to be executed (only via run-all), the frontend MUST invoke `postgres_run_sql_many` with the array produced by the splitter.

#### Scenario: Run with selection sends only the selection

- **WHEN** the user has the document `SELECT 1; SELECT 2;` and selects exactly `SELECT 2`, then presses `Mod-Enter`
- **THEN** `postgres_run_sql` is invoked with `sql: "SELECT 2"`

#### Scenario: Run without selection picks statement under cursor

- **WHEN** the document is `SELECT 1;\nSELECT 2;\nSELECT 3;` with the cursor on line 2
- **AND** the user presses `Mod-Enter`
- **THEN** `postgres_run_sql` is invoked with `sql: "SELECT 2"`

#### Scenario: Splitter ignores semicolons inside strings

- **WHEN** the document is `SELECT 'a;b'; SELECT 1;` and the cursor is in the second statement
- **THEN** the splitter yields exactly two statements (`SELECT 'a;b'` and `SELECT 1`)
- **AND** `Mod-Enter` runs `SELECT 1`

#### Scenario: Splitter respects dollar-quoted bodies

- **WHEN** the document is `CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql;\nSELECT 1;` and the cursor is on the SELECT line
- **THEN** the splitter yields exactly two statements (the CREATE FUNCTION through `LANGUAGE plpgsql` and the SELECT)
- **AND** `Mod-Enter` runs `SELECT 1`

#### Scenario: Run all invokes run_sql_many

- **WHEN** the document has three statements separated by `;` and the user presses `Mod-Shift-Enter`
- **THEN** `postgres_run_sql_many` is invoked with the array of three statement strings (in order)

#### Scenario: Cursor in whitespace runs preceding statement

- **WHEN** the document is `SELECT 1;\n\nSELECT 2;` with the cursor on the empty line between them
- **AND** the user presses `Mod-Enter`
- **THEN** `postgres_run_sql` is invoked with `sql: "SELECT 1"`

#### Scenario: Mod-Enter wins over default keymap

- **WHEN** the editor is focused and the user presses `Mod-Enter`
- **THEN** the run handler fires exactly once
- **AND** the editor's document is NOT modified (no newline is inserted by any default `Enter`-family binding)

### Requirement: Schema-aware autocomplete from in-memory cache

The editor SHALL offer autocomplete suggestions from **three composed sources** running in parallel inside a single `autocompletion({ override: [...] })` extension:

1. **Keyword source** — `keywordCompletionSource(PostgreSQL, /*upperCase=*/ true)` from `@codemirror/lang-sql`. Always available; suggests reserved words and built-in functions of the Postgres dialect.

2. **Schema source** — `schemaCompletionSource({ dialect: PostgreSQL, schema: namespace })` from `@codemirror/lang-sql`, where `namespace` is built from `globalSchemaCache.getNamespace(connectionId)`. This source MUST canonically handle:
   - Qualified names (`<schema>.<partial>`) by anchoring `from` immediately after the dot and filtering only the partial — no greedy capture of the schema portion.
   - Default-schema unqualified table completion (when the configuration includes a default schema).
   - FROM-clause aware column scoping: when the editor's parse tree shows `SELECT … FROM users u`, completing `u.` MUST suggest only the columns of `users`.
   - CTE awareness: tables declared in `WITH name AS (...)` MUST be available as completions in the body of the same statement.

3. **Document identifier source** — a custom source that walks the editor's syntax tree (via `syntaxTree(state)` from `@codemirror/language`) and extracts:
   - CTE names declared in `WITH … AS (…)` clauses.
   - Aliases declared in `FROM <table> [AS] <alias>` and `JOIN <table> [AS] <alias>` clauses.
   - Other identifiers that appear in `FromClause` / `JoinClause` positions.
   This source MUST NOT use raw regex to identify these tokens — it MUST use the parser's syntax tree so that strings, comments, and dollar-quoted bodies are correctly excluded.

The editor MUST keep the `sql({ dialect: PostgreSQL })` language configuration in a separate `Compartment` from `autocompletion`, so that reconfiguring the autocomplete sources (when the schema cache changes) does NOT re-instantiate the language or invalidate the syntax tree / highlighting / indent logic.

When `globalSchemaCache` notifies of a change, the editor MUST reconfigure the autocomplete `Compartment` to re-bind `schemaCompletionSource` to the new namespace, debounced 100ms. If the new namespace is shape-equal to the previous (same schema names with same relation name sets), the reconfigure MUST be skipped to avoid editor churn.

When neither schemas, relations, nor columns are loaded for the current connection, the editor MUST still function and offer **keyword-only completion** plus document identifiers found in the current buffer.

#### Scenario: Keywords always complete

- **WHEN** the editor is empty and the user types `SEL`
- **THEN** the autocomplete popup opens with `SELECT` as a top suggestion
- **AND** the suggestion has type `keyword`

#### Scenario: Qualified name completion is canonical

- **WHEN** the schema cache contains `public.users`, `public.orders`, `analytics.events`
- **AND** the user types `SELECT * FROM public.us`
- **THEN** the autocomplete popup shows `users` (and any other public.* relations matching `us`) as the top suggestion
- **AND** the popup does NOT consume the `public.` portion as part of the typed prefix — only `us` is the partial

#### Scenario: Alias-aware column completion

- **WHEN** the document is `SELECT u. FROM "public"."users" u` with the cursor right after `u.`
- **AND** the cache has columns for `public.users`
- **THEN** the autocomplete popup suggests every column of `public.users` (e.g. `id`, `email`, `created_at`)
- **AND** does NOT suggest columns of unrelated relations

#### Scenario: CTE name appears in completion

- **WHEN** the document is `WITH recent AS (SELECT * FROM events) SELECT * FROM rec`
- **AND** the cursor is right after `rec`
- **THEN** the autocomplete popup includes `recent` as a suggestion (sourced from the document identifier source)
- **AND** the suggestion's `detail` indicates it is a CTE

#### Scenario: Identifier with digits completes correctly

- **WHEN** the cache has `public.users_2024`
- **AND** the user types `SELECT * FROM users_20`
- **THEN** the autocomplete popup includes `users_2024` (the digit characters do not break the match)

#### Scenario: Cache update reconfigures autocomplete without breaking the editor

- **WHEN** a new schema `analytics` is bulk-loaded into the cache while a query tab is open
- **THEN** within ~100ms the editor's autocomplete reflects the new schema (typing `FROM analytics.` shows its relations)
- **AND** the editor's syntax highlighting, current selection, undo history, and any in-flight popup state are NOT disrupted

#### Scenario: Empty cache falls back gracefully

- **WHEN** the connection has just been activated and no schemas or columns are cached yet
- **AND** the user types `SEL`
- **THEN** the autocomplete popup shows `SELECT` (keyword source)
- **AND** does NOT throw or error
- **AND** the document identifier source returns no suggestions because the buffer is small

#### Scenario: Same-shape namespace skips reconfigure

- **WHEN** the cache notifies of a change but the resulting namespace has the same schemas and the same relations per schema as the previous reconfigure
- **THEN** the editor does NOT dispatch a reconfigure effect
- **AND** the autocomplete state is unchanged

### Requirement: Result panel for rows and affected outcomes

Each `postgres-query` tab SHALL render a result panel below the editor. The panel MUST:

- Render a hint state when no run has occurred yet in this tab. The hint MUST advertise both run and autocomplete shortcuts so the user discovers them on first use; the recommended copy is `Press ⌘↩ to run · Tab to autocomplete`.
- Render a virtualized read-only data grid (the `<AdhocResultGrid />` provided by `postgres-data-grid`) for `kind: "rows"` results, displaying the `columns` and `rows` from the response. The grid MUST support row selection that drives the shell's right inspector (when the inspector is expanded).
- Render a compact summary line for `kind: "affected"` results: `<command_tag> · <affected_rows> rows affected · <query_ms> ms`. Example: `INSERT 0 3 · 3 rows affected · 12 ms`.
- Display a banner above the grid `Result truncated at 10,000 rows — add a LIMIT clause to refine.` whenever the response has `truncated: true`.

The panel's height MUST be resizable via a drag handle on its top edge (between editor and panel) within bounds 120–800px; the height MUST persist per tab id under settings key `pgQueryResultHeight:<tabId>` while the tab exists.

#### Scenario: Empty state on fresh tab advertises run + autocomplete

- **WHEN** a `postgres-query` tab is opened and no run has been executed
- **THEN** the panel shows the hint `Press ⌘↩ to run · Tab to autocomplete`
- **AND** no grid is rendered

#### Scenario: Rows result renders the adhoc grid

- **WHEN** a SELECT returns 50 rows with 4 columns
- **THEN** the panel renders an `<AdhocResultGrid />` with those 50 rows and 4 columns
- **AND** clicking a row populates the shell's right inspector with that row's column-value list

#### Scenario: Affected result renders the compact summary

- **WHEN** an INSERT returns `{ kind: "affected", command_tag: "INSERT 0 3", affected_rows: 3, query_ms: 12 }`
- **THEN** the panel shows `INSERT 0 3 · 3 rows affected · 12 ms`
- **AND** no grid is rendered

#### Scenario: Truncation banner surfaces above the grid

- **WHEN** a SELECT returns 10,000 rows with `truncated: true`
- **THEN** a banner reads `Result truncated at 10,000 rows — add a LIMIT clause to refine.` above the grid

### Requirement: Error block with SQLSTATE and position

When a run results in `AppError::Postgres { code, message, position }` or `AppError::Validation { message }`, the result panel MUST render an error block in `var(--danger)` that displays:

- The error message verbatim.
- The SQLSTATE code in monospace (when present).
- An inline `Show in editor` button when `position` is present; activating it MUST move the editor's cursor to `position - 1` (CodeMirror is 0-based) within the most recently executed SQL.

For multi-statement runs, the failing statement's index MUST be shown as `Statement <i>` and clicking `Show in editor` MUST move the cursor to `statement.start_offset + position - 1` so the cursor lands at the actual error location in the source document.

#### Scenario: Single-statement syntax error renders inline error

- **WHEN** the user runs `SELEC 1`
- **THEN** the panel renders an error block with the Postgres message, SQLSTATE `42601`, and a `Show in editor` button
- **AND** activating `Show in editor` moves the cursor to the position reported by Postgres

#### Scenario: Multi-statement failing index is labeled

- **WHEN** a run-many produces `[ok, err, skipped]` and the failing entry has `position: 8`
- **THEN** the panel renders the error block prefixed with `Statement 2` and the `Show in editor` button moves the cursor to that statement's start plus the relative position

### Requirement: Multi-statement result sub-tabs

When a run returns more than one statement outcome (i.e. `postgres_run_sql_many` was invoked), the result panel MUST render sub-tabs (one per statement) in document order. Each sub-tab's label MUST follow the pattern `<i> · <summary>` where `<i>` is the 1-based statement index and `<summary>` is:

- `<rowCount> rows` for `kind: "rows"`.
- The `command_tag` for `kind: "affected"`.
- `✗ <code or "error">` for `status: "err"`.
- `… skipped` for `status: "skipped"`.

The first sub-tab MUST be selected by default, EXCEPT when one or more statements failed — in that case the first failed sub-tab MUST be selected automatically. The sub-tab content MUST render the same components as the single-statement panel (grid, summary, or error block).

#### Scenario: Three successes show three sub-tabs

- **WHEN** a run-many produces `[{ rows: 5 }, { rows: 12 }, { affected: "UPDATE 3" }]`
- **THEN** the panel renders three sub-tabs labeled `1 · 5 rows`, `2 · 12 rows`, `3 · UPDATE 3`
- **AND** sub-tab 1 is selected by default

#### Scenario: First failure auto-focuses

- **WHEN** a run-many produces `[ok, err, skipped]`
- **THEN** sub-tab 2 is selected automatically and shows the error block

### Requirement: Bottom status indicator

Each `postgres-query` tab SHALL display a status indicator inside the tab's chrome (between editor and result panel, or in the panel header). The indicator MUST show: the latest run's elapsed time (`12 ms`) and the latest run's outcome summary (`5 rows` or `3 rows affected` or `error`). When a run is in flight, the indicator MUST show a `Running…` state.

#### Scenario: Indicator updates after a successful run

- **WHEN** a SELECT completes returning 5 rows in 12 ms
- **THEN** the indicator reads `5 rows · 12 ms`

#### Scenario: Indicator shows running state

- **WHEN** a run has been dispatched and the response has not yet arrived
- **THEN** the indicator shows `Running…`

### Requirement: In-session SQL buffer persistence

Each `postgres-query` tab SHALL persist its SQL document under settings key `pgQueryBuffer:<tabId>` with a debounce of 500ms after the last keystroke. On tab mount, the editor MUST read this key and initialize its document from it (or from the tab payload's `sql` field if no setting exists). When the tab closes, the key MUST be removed. The shell does not currently restore tabs across app launches; this requirement only ensures the buffer survives focus changes and refreshes within a single session.

#### Scenario: Buffer survives switching tabs and returning

- **WHEN** the user types `SELECT 42` in a query tab, switches to another tab, and returns to the query tab
- **THEN** the editor still shows `SELECT 42`

#### Scenario: Closing the tab removes the buffer

- **WHEN** the user types into a query tab and then closes it
- **THEN** the settings key `pgQueryBuffer:<tabId>` no longer exists

### Requirement: Read-only banner above the editor

When the active connection has `params.read_only: true`, each `postgres-query` tab against that connection MUST render a banner above the editor reading `Read-only connection — non-SELECT statements will be rejected.` The banner MUST use `var(--accent-soft)` background and an icon. The editor and result panel MUST otherwise function normally (SELECTs run, EXPLAINs run); only mutations are rejected by the backend.

#### Scenario: Banner appears on read-only connection

- **WHEN** the user opens a query tab against a read-only connection
- **THEN** the banner is visible above the editor

#### Scenario: SELECT still runs on read-only connection

- **WHEN** the user runs `SELECT 1` on the read-only tab
- **THEN** the result panel renders the row normally with no error

### Requirement: Tab close discards buffer without confirm

Closing a `postgres-query` tab via `Mod-W` or the tab's close button MUST close the tab immediately and remove its `pgQueryBuffer:<tabId>` setting. No confirmation dialog MUST be shown, even if the document is non-empty. (Rationale: SQL in the editor is not yet committed to the database; losing it is not as costly as losing a dirty edit buffer.)

#### Scenario: Close drops the buffer with no prompt

- **WHEN** the user has typed `SELECT 1` and presses `Mod-W` on the query tab
- **THEN** the tab closes immediately
- **AND** no confirmation dialog appears
- **AND** the `pgQueryBuffer:<tabId>` key is removed

### Requirement: Prefilled SQL survives StrictMode mount race

When a `postgres-query` tab opens with a non-empty `payload.sql` (for example, via the data viewer's `Open in SQL Editor` action), the editor MUST mount with `payload.sql` as its initial document, on every code path — including under React 18 `<React.StrictMode>` dev double-mount.

The in-session SQL buffer cleanup ("closing a tab discards the buffer") MUST be tied to the actual tab-close gesture (the close-handler registry consulted by `TabStrip`), NOT to React unmount alone. A StrictMode replay (mount → cleanup → mount on the same tab) MUST NOT clobber the buffer with the empty string between the first mount's seeding and the second mount's read.

#### Scenario: Open in SQL Editor lands on the prefilled SQL in dev

- **WHEN** the user clicks `Open in SQL Editor` from a table viewer that has a non-empty applied filter
- **AND** the app is running with `<React.StrictMode>` enabled (dev mode)
- **THEN** the new query tab's editor mounts with the SQL produced by `compilePrefilledSelect` (`SELECT * FROM ... WHERE ... LIMIT N`) as its initial document
- **AND** the editor never displays an empty document for the lifetime of the tab

#### Scenario: Open in SQL Editor lands on the prefilled SQL in prod

- **WHEN** the user clicks `Open in SQL Editor` in production (no StrictMode replay)
- **THEN** the editor mounts with the same `compilePrefilledSelect` output

#### Scenario: Closing a query tab still removes the buffer

- **WHEN** the user closes a `postgres-query` tab via the close button or `Mod-W`
- **THEN** the `pgQueryBuffer:<tabId>` settings key is removed
- **AND** no confirmation dialog is shown

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
