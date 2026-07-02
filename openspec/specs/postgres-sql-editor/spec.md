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

The frontend SHALL register a tab kind `postgres-query` and SHALL render it in the center work area when the user activates a "New Query" entry point (sidebar button, palette command, double-click on a saved query). The tab payload MUST be `{ initialConnectionId?: string, initialConnectionName?: string, initialSql: string, savedQueryId?: string }`. The tab MUST have an id of the form `pgquery:<uuid>` where `<uuid>` is a fresh v4 UUID generated on tab creation; the id MUST NOT embed the connection id (the connection is mutable in runtime — see "Connection selector in editor toolbar").

When opening a `postgres-query` tab, the shell MUST route the tab to the per-connection tab set identified by the payload's `initialConnectionId` when present, and MUST do so regardless of whether any connection is currently focused. Only when the payload carries no `initialConnectionId` MAY the shell fall back to the currently focused connection. The shell MUST NOT require a focused connection to open a `postgres-query` tab that already names its connection in the payload. (This makes the `Open` / `Open in new tab` / double-click actions on a saved query reliable even when the saved-queries panel is shown without a focused connection.)

The current connection of a tab MUST live in per-tab state (`useQueryTabState`), not in the tab payload or in the tab id. When the tab is created, the current connection is initialized from `initialConnectionId` (or from the most recently-used connection of the saved query if `savedQueryId` is provided and the persisted `last_connection_id` references an existing connection), or unset if neither is available.

The default tab title MUST be:
- The saved query's `name` when `savedQueryId` is provided.
- `Query <N>` otherwise, where `N` is a global running counter starting at 1 (no longer per-connection, since tabs are no longer bound to a connection). The counter resets when the app launches.

Activating "New Query" with no `savedQueryId` MUST always create a new tab (never focus an existing one). Activating "Open" on a saved query whose `savedQueryId` matches an already-open tab MUST focus the existing tab instead of creating a new one. The "Open in new tab" action on a saved query MUST always create a new tab.

#### Scenario: New Query opens a fresh tab without a saved query binding

- **WHEN** the user clicks `+ Query` from the sidebar
- **THEN** a center-area tab of kind `postgres-query` opens with payload `{ initialConnectionId: <current focused connection or undefined>, initialSql: "", savedQueryId: undefined }` and id `pgquery:<uuid>`
- **AND** the tab title is `Query <N>` for the next global counter value

#### Scenario: Opening a saved query reuses existing tab

- **WHEN** a `postgres-query` tab already exists with `state.savedQueryId === "abc"`
- **AND** the user double-clicks the saved query `abc` in the sidebar tree
- **THEN** the existing tab is focused (no new tab created)

#### Scenario: Opening a saved query in a new tab forces creation

- **WHEN** a `postgres-query` tab already exists with `state.savedQueryId === "abc"`
- **AND** the user selects `Open in new tab` from the context menu on saved query `abc`
- **THEN** a second `postgres-query` tab is created with `state.savedQueryId === "abc"` and a fresh `pgquery:<uuid>` id
- **AND** both tabs coexist in the tab strip

#### Scenario: Saved query opens its tab when no connection is focused

- **WHEN** no connection is currently focused
- **AND** the user double-clicks (or selects `Open` / `Open in new tab` on) a Postgres saved query `abc` whose `last_connection_id` is `conn-prod`, a currently registered connection
- **THEN** a `postgres-query` tab is created in the `conn-prod` tab set loaded with the saved query's SQL
- **AND** the open action is not a silent no-op

#### Scenario: Saved query tab routes to its own connection, not the focused one

- **WHEN** connection `conn-a` is focused
- **AND** the user opens a Postgres saved query bound to `conn-prod`
- **THEN** the new `postgres-query` tab is created in the `conn-prod` tab set (identified by the payload `initialConnectionId`), not in the focused `conn-a` set

#### Scenario: Saved query restores last_connection_id when present

- **WHEN** the user opens saved query `abc` and its persisted `last_connection_id` is `conn-prod` which is a currently registered connection
- **THEN** the new tab's current connection is set to `conn-prod` and the editor toolbar's connection selector reflects this

#### Scenario: Saved query without a valid last connection opens with selector empty

- **WHEN** the user opens a saved query whose `last_connection_id` is null OR references a connection that no longer exists in the registry
- **THEN** the tab opens with no current connection and the editor toolbar's selector shows a placeholder prompting selection

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
- Render a virtualized read-only data grid (the `<AdhocResultGrid />` provided by `postgres-data-grid`) for `kind: "rows"` results, displaying the `columns` and `rows` from the response. The grid MUST support **row-range selection** (via a row-number gutter: plain click, shift-click, and drag) as well as single-cell selection, and the current row selection MUST drive the shell's right inspector (when the inspector is expanded) — a single-row selection shows one row, a multi-row selection shows all selected rows. The grid MUST support ⌘C / Ctrl+C copy (single cell or the selected row range as TSV), ⌘A / Ctrl+A select-all, and a read-only right-click context menu (Copy cell / Copy row(s)), per the `grid-cell-copy`, `grid-row-copy`, `grid-row-selection`, `grid-select-all`, and `grid-context-menu` capabilities. Column widths inside the grid MUST default to the type-derived base widths defined by `column-width-preferences` and MUST be user-resizable; resizing MUST NOT persist to disk across runs or sessions, but MUST persist within the same `<AdhocResultGrid />` instance for as long as the columns prop shape is unchanged.
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
- **AND** selecting a row from the gutter populates the shell's right inspector with that row's column-value list

#### Scenario: Multi-row selection drives the inspector

- **WHEN** the user selects a range of rows (e.g. rows 2–4) via the gutter in the result grid
- **THEN** the shell's right inspector shows the column-value view for all selected rows

#### Scenario: Copy selected rows from the result grid

- **WHEN** the user selects rows 2–4 in the result grid and presses ⌘C
- **THEN** those three rows are copied to the clipboard as TSV

#### Scenario: Affected result renders the compact summary

- **WHEN** an INSERT returns `{ kind: "affected", command_tag: "INSERT 0 3", affected_rows: 3, query_ms: 12 }`
- **THEN** the panel shows `INSERT 0 3 · 3 rows affected · 12 ms`
- **AND** no grid is rendered

#### Scenario: Truncation banner surfaces above the grid

- **WHEN** a SELECT returns 10,000 rows with `truncated: true`
- **THEN** a banner reads `Result truncated at 10,000 rows — add a LIMIT clause to refine.` above the grid

#### Scenario: Adhoc grid column widths reset when columns prop changes

- **WHEN** the user runs `SELECT id, email FROM users`, resizes `email` to 320px, then runs `SELECT id, email, status FROM users` in the same tab
- **THEN** the new result re-renders the grid with `id`, `email`, and `status` at their type-derived base widths
- **AND** the previous 320px override for `email` is discarded

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

Each `postgres-query` tab SHALL display a status indicator inside the tab's chrome (between editor and result panel, or in the panel header). The indicator MUST show: the latest run's elapsed time (`12 ms`) and the latest run's outcome summary (`5 rows` or `3 rows affected` or `error`). When a run is in flight, the indicator MUST show the live elapsed-time text per the "Live elapsed-time indicator while running" requirement (i.e. `Running…` for the first second, then `Running… <s>s` up to a minute, then `Running… <m>:<ss>` past one minute).

#### Scenario: Indicator updates after a successful run

- **WHEN** a SELECT completes returning 5 rows in 12 ms
- **THEN** the indicator reads `5 rows · 12 ms`

#### Scenario: Indicator shows running state with live elapsed time

- **WHEN** a run has been in flight for 2300ms and the response has not yet arrived
- **THEN** the indicator reads `Running… 2.3s`
- **AND** the text continues to tick approximately every 100ms until the run completes

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

### Requirement: Postgres server message surfaces verbatim in error envelope

When the backend converts a `tokio_postgres::Error` into `AppError::Postgres`, the `PostgresErrorBody.message` field MUST carry the **Postgres-server-supplied** error message — not `tokio_postgres::Error`'s top-level `Display` string. Specifically:

- When `tokio_postgres::Error::as_db_error()` returns `Some(db)`, the `message` field MUST be built by joining the following with a single `\n`, in order, omitting any line whose accessor returns `None`:
  1. `db.message()` (always present; this is the first line).
  2. `"DETAIL: " + db.detail()` when `db.detail()` is `Some`.
  3. `"HINT: " + db.hint()` when `db.hint()` is `Some`.
  4. `"WHERE: " + db.where_()` when `db.where_()` is `Some`.
- When `tokio_postgres::Error::as_db_error()` returns `None` (transport/protocol/timeout errors with no server-side payload), the `message` field MUST fall back to `tokio_postgres::Error::to_string()` so transport diagnostics are preserved.

The `code` and `position` fields of `PostgresErrorBody` are unchanged: `code` MUST be the SQLSTATE extracted via the existing `e.code()` / `e.as_db_error().code()` chain, and `position` MUST be the 1-based offset extracted via the existing `e.as_db_error().position()` chain.

The wire shape of `AppError::Postgres` (`{ kind: "Postgres", message: { code, message, position } }`) is unchanged. Only the contents of the inner `message` string change.

This requirement applies to every Tauri command that converts a `tokio_postgres::Error` via the standard `From` impl, including `postgres_run_sql`, `postgres_run_sql_many`, structured-edit, structured-filter, and schema/columns commands.

#### Scenario: Invalid jsonb cast surfaces the server message

- **WHEN** the user runs `UPDATE market.product SET metadata = REPLACE(metadata::text, 'a', 'b')::jsonb` in the SQL editor and Postgres rejects the result because the produced text is not valid JSON
- **THEN** `AppError::Postgres.message.code` is `"22P02"`
- **AND** `AppError::Postgres.message.message` starts with the Postgres server message (for example `"invalid input syntax for type json"`) and is **NOT** the literal string `"db error"`
- **AND** the SQL editor's error block renders that server message verbatim

#### Scenario: DETAIL and HINT are appended on separate lines

- **WHEN** Postgres returns an error carrying a `DETAIL` and a `HINT` (for example, a unique-constraint violation that includes the offending row in `DETAIL`)
- **THEN** `AppError::Postgres.message.message` consists of the server message on the first line, `"DETAIL: <detail text>"` on the second line, and `"HINT: <hint text>"` on the third line, separated by `\n`
- **AND** the SQL editor's error block (which already uses `white-space: pre-wrap` on `.errorMessage`) renders all three lines visibly

#### Scenario: Server message without DETAIL or HINT is single-line

- **WHEN** Postgres returns an error with only a `MESSAGE` field (for example, a simple `syntax error at or near "SELEC"`)
- **THEN** `AppError::Postgres.message.message` is exactly the server message with no trailing newline and no `DETAIL:` / `HINT:` / `WHERE:` lines

#### Scenario: Transport errors preserve current diagnostic text

- **WHEN** a query fails because the connection was closed mid-flight (a `tokio_postgres::Error` whose `as_db_error()` returns `None`)
- **THEN** `AppError::Postgres.message.message` falls back to `tokio_postgres::Error::to_string()` (a diagnostic kind tag such as `"connection closed"` or `"db error: …"`)
- **AND** `AppError::Postgres.message.code` is `None` (no SQLSTATE available)

#### Scenario: Activity log and query history pick up the server message

- **WHEN** a SQL run fails with a Postgres server error
- **THEN** the `argus:activity-log` event's `error.message` is the same server-message-derived string surfaced to the SQL editor
- **AND** the corresponding `query_history` row's `error_message` column is that same string
- **AND** the `error_code` column is the SQLSTATE

### Requirement: Format SQL action

Each `postgres-query` tab SHALL render a thin toolbar at the top of the editor area containing a `Format` button. The editor SHALL also bind `Mod-Shift-F` to the same action at `Prec.highest` so it cannot be intercepted by other extensions. When invoked:

- The action MUST run the entire editor document through the project's `formatSql(input: string): string` helper, which MUST wrap `sql-formatter` configured with `{ language: "postgresql", keywordCase: "upper", identifierCase: "preserve", dataTypeCase: "upper", functionCase: "lower", indentStyle: "standard", tabWidth: 2, expressionWidth: 80, linesBetweenQueries: 1 }`.
- The action MUST replace the editor document with the formatted output via a single CodeMirror transaction so undo restores the pre-format text in one step.
- After replacement, the cursor MUST be set to offset 0 and the view scrolled to the top.
- If the document is empty or contains only whitespace, the action MUST be a no-op (no transaction dispatched, no error).
- If `sql-formatter` throws (malformed SQL it cannot tokenize), the editor MUST leave the document untouched and surface a non-blocking error toast `Could not format SQL`. The original buffer MUST NOT be lost.

The `Format` button MUST display the keyboard shortcut hint `⌘⇧F` (or `Ctrl+Shift+F` on non-Mac) inline with the label so users discover the binding.

#### Scenario: Format button reformats the buffer

- **WHEN** the editor contains `select id,name from "public"."users" where id=1`
- **AND** the user clicks the `Format` button
- **THEN** the editor document becomes a multi-line formatted version with `SELECT` and `FROM` uppercased, fields aligned, and 2-space indentation
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

- **WHEN** the editor contains text the formatter cannot tokenize (e.g. an unclosed dollar-quoted block)
- **AND** the user clicks `Format`
- **THEN** the editor document is unchanged
- **AND** a toast appears reading `Could not format SQL`

### Requirement: Live elapsed-time indicator while running

While a run is in flight, the result header's summary slot SHALL display a live elapsed time that updates at 100ms intervals. The text MUST follow these rules, where `ms` is the elapsed time since the run started in the client:

- `ms < 1000` → `Running…`
- `1000 ≤ ms < 60000` → `Running… <s>` where `<s>` is the elapsed seconds with one decimal (e.g. `Running… 1.2s`, `Running… 12.4s`)
- `ms ≥ 60000` → `Running… <m>:<ss>` where `<m>` is whole minutes and `<ss>` is two-digit seconds (e.g. `Running… 1:23`, `Running… 10:05`)

The interval MUST live on the result header component only (not in `useQueryRun` or any parent), so re-renders triggered by the tick MUST NOT re-render the editor, the grid, or any sibling tab. The interval MUST be cleared when the result-header component unmounts and when the run completes.

`useQueryRun` SHALL expose `runStartedAt: number | null` (the `Date.now()` at which the most recent run transitioned to `running`, or `null` while idle/done) so the header can compute elapsed time without recreating the timer source.

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

### Requirement: Export single-statement rows result

The result panel SHALL render an `Export ▾` dropdown trigger inside the result header (positioned to the right of the run summary) when, and only when, ALL of the following are true:

- `runner.state.status === "done"`,
- `runner.state.mode === "single"`,
- `runner.state.result?.kind === "rows"`,
- `runner.state.result.rows.length > 0`.

Otherwise the dropdown trigger MUST NOT be rendered. (Multi-statement runs and `kind: "affected"` results MUST NOT show an export action in this version.)

The dropdown menu MUST list exactly three items in this order: `Export as CSV`, `Export as Excel (.xlsx)`, `Export as JSONL`. Selecting an item MUST:

1. Open a Tauri save dialog (`@tauri-apps/plugin-dialog`) with a default filename of the form `${connectionName}_query_${YYYYMMDD_HHmmss}.${ext}`, with `_truncated` inserted before the extension when `result.truncated === true`. The dialog's filter MUST match the chosen format (`*.csv`, `*.xlsx`, or `*.jsonl`).
2. If the user cancels (returns `null`), the action MUST silently no-op.
3. If the user confirms, the frontend MUST serialize the rows in the chosen format and write the file via `@tauri-apps/plugin-fs` (`writeTextFile` for CSV/JSONL, `writeFile` with a `Uint8Array` for XLSX).
4. On write success, surface a brief success toast (e.g. `Exported 5,000 rows`).
5. On write failure, surface an error toast with the failure message; the original result MUST remain untouched in memory.

The serializers MUST behave as follows:

- **CSV**: UTF-8 with a leading BOM. RFC 4180 quoting (a field is quoted iff it contains `"`, `,`, `\n`, or `\r`; embedded `"` is escaped as `""`). `null` cells become empty strings. The header row uses column `name`. Line ending is `\r\n`.
- **JSONL**: one JSON object per line, no trailing newline. Object keys are column `name`. `null` cells serialize as JSON `null`. Numbers, booleans, and other JSON-native types from the `Value` envelope serialize natively (no string coercion).
- **XLSX** (via `exceljs`, lazy-loaded on first invocation): a single sheet named `Result` with the header row at row 1 and frozen. Cell typing is driven by `DataColumn.data_type`:
  - integer/numeric/floating point types → numeric cell when the parsed `Number` is finite, else string.
  - `bool`/`boolean` → boolean cell.
  - timestamp/date types → `Date` cell when `new Date(value)` is not `NaN`, else string.
  - `json`/`jsonb` → string cell containing `JSON.stringify(value)`.
  - everything else → string cell (or empty for null).
  Column widths SHOULD be derived from the longest cell up to a cap of 60 characters.

When `result.truncated === true`, the export MUST proceed using only the rows already in memory; the `_truncated` filename suffix is the user-visible signal that the export is partial. The export action MUST NOT re-execute the query without the row cap.

#### Scenario: Export trigger only appears for rows results

- **WHEN** a SELECT returns 5 rows and the run completes
- **THEN** the `Export ▾` trigger is rendered in the result header

#### Scenario: Export trigger hidden for affected results

- **WHEN** an INSERT returns `{ kind: "affected", … }`
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

#### Scenario: JSONL export preserves JSON types

- **WHEN** the result has columns `id (int)`, `active (bool)`, `name (text)`, `meta (jsonb)` and a row `[7, true, null, {"k":"v"}]`
- **AND** the user chooses `Export as JSONL`
- **THEN** that line of the file is `{"id":7,"active":true,"name":null,"meta":{"k":"v"}}`

#### Scenario: XLSX export types numeric and date cells

- **WHEN** the result has a column `created_at` of type `timestamp` with value `"2026-05-06T12:00:00Z"` and a column `n` of type `int4` with value `42`
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

- **WHEN** the active connection's name is `local-pg` and the time is `2026-05-06 14:30:05`
- **AND** the user chooses `Export as JSONL` on a non-truncated result
- **THEN** the save dialog's default filename is `local-pg_query_20260506_143005.jsonl`

### Requirement: Connection selector in editor toolbar

Each `postgres-query` tab SHALL render a connection selector control as the leftmost element of the editor toolbar (the same toolbar that hosts `Format` and `Save`). The selector MUST:

- Display the name of the currently-selected connection along with a status dot reusing the status visualization from the Connections sidebar (e.g. green when connected, gray when disconnected). When no connection is selected, the trigger shows the placeholder `Select connection…`.
- Open a dropdown listing every connection registered in the connection registry, ordered the same way as the Connections sidebar (groups respected). Each item shows the connection name, the same status dot, and the connection's human-readable engine type label.
- Render the engine type label using the shared `engineLabel(kind)` helper (`PostgreSQL`, `MySQL`, `SQL Server`, `DynamoDB`, `Athena`, falling back to the raw `kind` for unknown engines). The label MUST appear beside the connection name as muted, neutral text (no accent color) and MUST NOT collapse or truncate the connection name. The trigger (collapsed) state is NOT required to show the type label.
- On selection, update the tab's `currentConnectionId` and `currentConnectionName` in `useQueryTabState`.

Switching connections MUST:

1. Reconfigure the autocomplete `Compartment` of the editor to re-bind `schemaCompletionSource` to `globalSchemaCache.getNamespace(newConnectionId)`, following the same debounce and shape-equality skip rules already specified in "Schema-aware autocomplete from in-memory cache".
2. Discard the current `runner.state` (any prior result was bound to the previous connection). The result panel reverts to the empty hint state.
3. NOT mark the tab as dirty (the saved query record does not track connection).
4. When `state.savedQueryId` is set, persist the new `currentConnectionId` to the saved query's `last_connection_id` via `saved_queries_update`, debounced 1000ms, fire-and-forget.

When the user invokes Run (`Mod-Enter`, `Mod-Shift-Enter`) with no connection selected, the frontend MUST surface a toast `Select a connection first.` and MUST NOT invoke `postgres_run_sql` or `postgres_run_sql_many`.

The selector's connection list MUST reactively update when connections are added, removed, renamed, or change connection state.

#### Scenario: Selector reflects current connection with status dot

- **WHEN** the tab's current connection is `prod_db` and it is connected
- **THEN** the selector trigger displays `prod_db` with a green status dot

#### Scenario: Dropdown items show the engine type label

- **WHEN** the dropdown is open and lists a Postgres connection `prod_db` and a DynamoDB connection `events`
- **THEN** the `prod_db` item shows the name `prod_db` with a muted `PostgreSQL` label
- **AND** the `events` item shows the name `events` with a muted `DynamoDB` label
- **AND** the type label does not truncate or hide either connection name

#### Scenario: Changing connection re-binds autocomplete

- **WHEN** the user has the editor open with `prod_db` selected and types `SELECT * FROM public.` to confirm completions reflect `prod_db` schema
- **AND** the user changes the selector to `staging_db`
- **THEN** within ~100ms typing `SELECT * FROM public.` shows completions from `staging_db`'s schema cache (or empty if not loaded)
- **AND** the editor's syntax highlighting, undo history, and cursor are preserved

#### Scenario: Changing connection clears the result panel

- **WHEN** a result is displayed from a SELECT against `prod_db`
- **AND** the user changes the selector to `staging_db`
- **THEN** the result panel reverts to the empty hint state (`Press ⌘↩ to run · Tab to autocomplete`)
- **AND** the tab is NOT marked dirty by the connection change

#### Scenario: Run with no connection selected is rejected client-side

- **WHEN** the tab has no current connection and the user presses `Mod-Enter` with non-empty SQL
- **THEN** a toast `Select a connection first.` appears
- **AND** neither `postgres_run_sql` nor `postgres_run_sql_many` is invoked

#### Scenario: Selector persists last_connection_id for saved query

- **WHEN** a tab has `state.savedQueryId = "abc"` and the user changes the connection to `staging_db`
- **THEN** within ~1 second `saved_queries_update({ id: "abc", last_connection_id: "<staging_db uuid>" })` is invoked
- **AND** the tab is NOT marked dirty

### Requirement: Save action in editor toolbar

Each `postgres-query` tab SHALL render a `Save` button in the editor toolbar (to the right of the connection selector, before `Format`). The editor SHALL also bind `Mod-S` to the same action at `Prec.highest` so it cannot be intercepted by other extensions or browser defaults.

When invoked, the action MUST:

- **First save (no `state.savedQueryId`)**: open a modal `SaveAsModal` with two fields — `Name` (text input, required, pre-filled with the tab title if non-default) and `Folder` (a tree picker of `saved_query_folders`, defaulting to the value stored in settings key `savedQueries:lastUsedFolder` or root if unset). The modal MUST provide a `+ New folder…` affordance that inline-creates a child folder under the current selection. On confirm:
  1. Invoke `saved_queries_create({ folder_id, name, sql: <current editor text>, last_connection_id: <current connection id or null> })`.
  2. Update tab state: `savedQueryId = record.id`, `savedSql = record.sql`, `savedName = record.name`, `savedFolderId = record.folder_id`. Set `tab.title = record.name`.
  3. Persist `savedQueries:lastUsedFolder = folder_id` in settings.
  4. Surface a brief success toast `Saved as "<name>"`.

- **Subsequent saves (`state.savedQueryId` present)**: directly invoke `saved_queries_update({ id, name: <state.editedName ?? savedName>, sql: <current editor text> })`. No modal. On success, update `savedSql` and `savedName` to the new values and bump the tab title if the name changed. Surface a brief toast `Saved`.

The action MUST be a no-op (silent, no toast, no command) if the tab is not dirty (current SQL and name equal the saved snapshot). The action MUST still be invokable when the editor is empty (an empty saved query is valid).

#### Scenario: First save opens the modal

- **WHEN** the user has a new tab with `SELECT 1` typed and no `savedQueryId`
- **AND** the user presses `Mod-S`
- **THEN** a `SaveAsModal` appears with Name pre-filled, Folder defaulting to the last used folder
- **AND** confirming with name `Test` invokes `saved_queries_create` with `{ name: "Test", sql: "SELECT 1", folder_id, last_connection_id }`
- **AND** the tab's title becomes `Test` and its `state.savedQueryId` is set

#### Scenario: Subsequent save is direct overwrite

- **WHEN** a tab already has `state.savedQueryId = "abc"` and the user edits the SQL
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

Each `postgres-query` tab SHALL track a `dirty: boolean` derived from:

- For tabs with `state.savedQueryId`: `dirty = (currentSql !== savedSql) || (currentName !== savedName)`.
- For tabs without `state.savedQueryId`: `dirty = currentSql.trim().length > 0`.

The dirty state MUST surface visually as a leading `●` character before the tab title in the tab strip. The tooltip on the dirty indicator MUST read `Unsaved changes`.

Changing the current connection MUST NOT affect `dirty`. Successfully running the query MUST NOT clear `dirty`. Only a successful `Save` (or reverting edits to match the saved snapshot) clears `dirty`.

When the user attempts to close a `dirty` tab via `Mod-W` or the tab close button:

- If the tab has `state.savedQueryId`: show a confirmation dialog `Discard unsaved changes to "<name>"?` with buttons `Discard` (destructive) and `Cancel` (default). Only `Discard` proceeds with closing.
- If the tab has NO `state.savedQueryId` (never-saved scratch buffer with content): close immediately without prompt (preserves the existing "Tab close discards buffer without confirm" behavior for ad-hoc queries).

After closing in either case, the `pgQueryBuffer:<tabId>` settings key MUST still be removed per the existing requirement.

#### Scenario: Editing a saved query marks it dirty

- **WHEN** a tab is bound to a saved query and the user types one character into the editor
- **THEN** the tab title is prefixed with `● `
- **AND** the tooltip on the dot reads `Unsaved changes`

#### Scenario: Reverting edits clears dirty

- **WHEN** a tab is dirty because of one edit
- **AND** the user undoes that edit so the buffer matches `savedSql` again
- **THEN** the leading `● ` disappears from the tab title

#### Scenario: Saving clears dirty

- **WHEN** a dirty tab is saved via `Mod-S`
- **THEN** the leading `● ` disappears immediately on success

#### Scenario: Connection change does not mark dirty

- **WHEN** a clean tab (no `● `) has the connection switched via the toolbar selector
- **THEN** the tab remains clean (no `● `)

#### Scenario: Closing dirty saved query prompts to discard

- **WHEN** a tab has `state.savedQueryId` set and is dirty, and the user presses `Mod-W`
- **THEN** a confirmation dialog `Discard unsaved changes to "<name>"?` appears
- **AND** clicking `Cancel` keeps the tab open
- **AND** clicking `Discard` closes the tab and removes the `pgQueryBuffer:<tabId>` key

#### Scenario: Closing dirty ad-hoc tab is immediate

- **WHEN** a tab has no `state.savedQueryId` and is dirty (non-empty SQL)
- **AND** the user presses `Mod-W`
- **THEN** the tab closes immediately without a prompt
- **AND** the `pgQueryBuffer:<tabId>` key is removed

### Requirement: Query tab result and editor state survive tab switches

A `postgres-query` tab SHALL retain the following in-memory state across any sequence of tab activations and deactivations within the same app session:

- The CodeMirror editor document (already covered by the existing `pgQueryBuffer:<tabId>` persistence requirement, but MUST also be preserved without a settings round-trip on activation).
- The editor's caret position, selection range, scroll position, and undo history.
- The last query result(s) — rows, affected counts, multi-statement sub-tabs, the active sub-tab — for as long as the tab is open.
- Error blocks (SQLSTATE, position, server message) from the most recent failed run.
- The live elapsed-time indicator state for any in-flight run.
- Read-only banner visibility (derived from connection state — must remain consistent on return).

Switching away from a query tab and back MUST NOT re-execute the last query, MUST NOT clear the result, and MUST NOT reset the editor selection or scroll position.

A query tab MAY re-execute only in response to the user explicitly running it (the Run shortcut, the Run button, or the statement-under-cursor action).

Closing a query tab MUST discard the retained result and editor state. The existing `Tab close discards buffer without confirm` requirement applies unchanged.

#### Scenario: Query result persists across tab switch

- **WHEN** the user runs `SELECT * FROM users LIMIT 10` in a query tab, observes the result panel, switches to another tab, then returns
- **THEN** the result panel still shows the same 10 rows
- **AND** no `postgres_run_sql` (or equivalent run command) is dispatched as a result of the activation
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

### Requirement: "Generate SQL" toolbar affordance

The Postgres SQL editor toolbar (`src/modules/postgres/sql/QueryEditor.tsx`) MUST host a "✨ Generate" button positioned after the existing "Save" button and styled consistently with the existing toolbar buttons. The button's visibility, click behaviour, and modal coupling are specified in the `ai-sql-generation` capability. The existing run / save / read-only behaviours of the editor MUST be unchanged by this addition.

#### Scenario: Button placement does not disturb existing toolbar

- **WHEN** the Postgres `QueryEditor` is rendered with AI configured
- **THEN** the toolbar contains, in order: "▶ Run", "💾 Save", "✨ Generate", followed by any other existing controls
- **AND** the visual styling of "Run" and "Save" is unchanged

#### Scenario: Run behaviour unchanged with AI configured

- **GIVEN** AI is configured and the "✨ Generate" button is visible
- **WHEN** the user types `"SELECT 1;"` and clicks "▶ Run"
- **THEN** the existing `postgres_run_sql` flow executes exactly as it did before this change
- **AND** the activity-log event emitted is identical to the pre-change behaviour

### Requirement: Cancel a running query

The Postgres module SHALL allow a user-initiated run (`postgres_run_sql` / `postgres_run_sql_many`) to be cancelled. The run command SHALL accept a frontend-generated `run_token`, register its `client.cancel_token()` in the shared in-flight registry under that token, and on `cancel_running_query(run_token)` fire the cancel token (Postgres cancel-request protocol) so the server aborts the statement. The run SHALL then resolve as cancelled. The editor SHALL present a Stop control and cancel shortcut while running and return to idle on cancel.

#### Scenario: User cancels a long-running statement

- **WHEN** a `SELECT pg_sleep(30)` is running and the user clicks Stop (or presses the cancel shortcut)
- **THEN** `cancel_running_query` fires the connection's cancel token, the server aborts the query, and the editor returns to idle showing "Query cancelled"
- **AND** no result rows and no error block are displayed

#### Scenario: Cancel during a multi-statement run

- **WHEN** the user cancels while `postgres_run_sql_many` is executing statement *k*
- **THEN** the in-flight statement is aborted, the batch stops, and the whole run resolves to the neutral cancelled state (no error block, no partial rows)

