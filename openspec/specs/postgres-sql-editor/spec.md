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

`postgres_run_sql`, each step of `postgres_run_sql_many`, and `postgres_run_sql_stream` SHALL cap
the returned row set at the **effective cap** resolved per statement by the `sql-result-row-cap`
capability — `min(HARD_ROW_CAP, max(configured_cap, explicit_statement_limit))`, where
`configured_cap` comes from the `sql.rowCap` setting (default 10,000) and
`explicit_statement_limit` is the `Dialect::Postgres` result of `explicit_row_limit` (trailing
depth-0 `LIMIT <int>` or `FETCH FIRST|NEXT <int> ROWS ONLY`).

When a query produces more rows than the effective cap, the backend MUST return the first
`row_cap` rows in `rows`, MUST set `truncated: true` in the response, and MUST stop fetching
further rows from the server (drop the iterator / discard the remainder). The cap is
per-statement, not per-run. The backend MUST fetch up to `effective_cap + 1` rows and set
`truncated = (fetched > effective_cap)`, so a result landing exactly on the cap is reported
complete — see `sql-result-row-cap`, "Exactly-at-cap results are not truncated". The `query_ms` MUST measure end-to-end including the time spent
fetching the cap-many rows.

An explicit `LIMIT` in the statement MUST NOT be overridden downward: the effective cap is never
lower than the statement's own limit up to `HARD_ROW_CAP`.

#### Scenario: Query returning under cap is not truncated

- **WHEN** a SELECT returns 4,200 rows
- **THEN** the response has `rows.length === 4200` and `truncated: false`

#### Scenario: Query exceeding cap is truncated to 10,000 with marker

- **WHEN** a SELECT against a 1M-row table runs without LIMIT and `sql.rowCap` is 10,000
- **THEN** the response has `rows.length === 10000`, `truncated: true`, and `row_cap: 10000`
- **AND** the activity-log event metric is `{ kind: "rows", value: 10000 }`

#### Scenario: Explicit LIMIT above the configured cap is honoured

- **WHEN** the user runs `SELECT * FROM some_big_table LIMIT 30000` against a table with more than 30,000 rows, with `sql.rowCap` at 10,000
- **THEN** the response has `rows.length === 30000`, `truncated: false`, and `row_cap: 30000`
- **AND** the activity-log event metric is `{ kind: "rows", value: 30000 }`

#### Scenario: Explicit LIMIT beyond the hard ceiling is clamped

- **WHEN** the user runs `SELECT * FROM some_big_table LIMIT 5000000`
- **THEN** the response has `rows.length === 1000000`, `truncated: true`, `row_cap: 1000000`, and `row_cap_source: "hard_ceiling"`

#### Scenario: LIMIT inside a subquery does not raise the cap

- **WHEN** the user runs `SELECT * FROM t WHERE id IN (SELECT id FROM u LIMIT 50000)` with `sql.rowCap` at 10,000 and the outer query matching more than 10,000 rows
- **THEN** the response has `rows.length === 10000`, `truncated: true`, and `row_cap: 10000`

#### Scenario: Result landing exactly on the cap is complete

- **WHEN** a SELECT matches exactly 10,000 rows and the effective cap is 10,000
- **THEN** the response has `rows.length === 10000` and `truncated: false`

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
- Render a virtualized data grid (the `<AdhocResultGrid />` provided by `postgres-data-grid`) for `kind: "rows"` results, displaying the `columns` and `rows` from the response. **The grid is read-only unless the conditions in "Inline cell editing in the SQL editor result grid" are met, in which case the panel supplies the grid's edit configuration derived from the response's `editability` payload.** **For a streaming run, the grid MUST render as soon as the `columns` event arrives and MUST append rows progressively as each `batch` event is received — the user sees the first rows without waiting for the run to complete; while the run is in flight the grid stays read-only.** The grid MUST support **row-range selection** (via a row-number gutter: plain click, shift-click, and drag) as well as single-cell selection, and the current row selection MUST drive the shell's right inspector (when the inspector is expanded) — a single-row selection shows one row, a multi-row selection shows all selected rows. **The result-panel inspector remains read-only regardless of the grid's edit mode.** The grid MUST support ⌘C / Ctrl+C copy (single cell or the selected row range as TSV), ⌘A / Ctrl+A select-all, and a right-click context menu (Copy cell / Copy row(s), plus **Edit cell when that cell is editable**), per the `grid-cell-copy`, `grid-row-copy`, `grid-row-selection`, `grid-select-all`, and `grid-context-menu` capabilities. **Copy MUST reflect any pending edit for a cell rather than its server value, matching the table viewer.** Column widths inside the grid MUST default to the type-derived base widths defined by `column-width-preferences` and MUST be user-resizable; resizing MUST NOT persist to disk across runs or sessions, but MUST persist within the same `<AdhocResultGrid />` instance for as long as the columns prop shape is unchanged.
- **While a streaming run is in flight, display a progress indicator above the grid showing the live count of rows received so far (e.g. `Loading… 3,412 rows`). The indicator MUST clear when the run reaches its terminal event.**
- Render a compact summary line for `kind: "affected"` results: `<command_tag> · <affected_rows> rows affected · <query_ms> ms`. Example: `INSERT 0 3 · 3 rows affected · 12 ms`.
- Display the shared `<TruncationBanner />` above the grid whenever the result is `truncated`, per the `sql-result-row-cap` capability. The banner MUST name the response's `row_cap` rather than a hardcoded `10,000`. Once the streaming `done` event carries `truncated: true` the run reaches its terminal state and the banner renders exactly as it does for a non-streaming run; while a run is still in flight no banner is shown, since no cap information exists until that terminal event. Its dialect clause is `LIMIT`. **A truncated result MAY still be edited: rows are addressed by primary key, so the rows that were returned are exactly the rows that can be written.**

The panel's height MUST be resizable via a drag handle on its top edge (between editor and panel) within bounds 120–800px; the height MUST persist per tab id under settings key `pgQueryResultHeight:<tabId>` while the tab exists.

#### Scenario: Empty state on fresh tab advertises run + autocomplete

- **WHEN** a `postgres-query` tab is opened and no run has been executed
- **THEN** the panel shows the hint `Press ⌘↩ to run · Tab to autocomplete`
- **AND** no grid is rendered

#### Scenario: Rows result renders the adhoc grid

- **WHEN** a SELECT returns 50 rows with 4 columns
- **THEN** the panel renders an `<AdhocResultGrid />` with those 50 rows and 4 columns
- **AND** selecting a row from the gutter populates the shell's right inspector with that row's column-value list

#### Scenario: Grid populates progressively during a streaming run

- **WHEN** a streaming SELECT is in flight and has delivered its `columns` event plus two `batch` events totaling 800 rows
- **THEN** the grid is already rendered showing those 800 rows
- **AND** a progress indicator reads `Loading… 800 rows`
- **AND** the run has not yet reached its terminal event

#### Scenario: Grid is read-only while streaming

- **WHEN** a streaming SELECT of an editable projection is still in flight and the user double-clicks a cell
- **THEN** no editor opens
- **AND** the cell's hover title reads `Not editable while the query is still loading`

#### Scenario: Progress indicator clears on completion

- **WHEN** a streaming SELECT reaches its `done` event with `row_count: 800`
- **THEN** the `Loading…` progress indicator is no longer shown
- **AND** the grid shows all 800 rows

#### Scenario: Multi-row selection drives the inspector

- **WHEN** the user selects a range of rows (e.g. rows 2–4) via the gutter in the result grid
- **THEN** the shell's right inspector shows the column-value view for all selected rows

#### Scenario: Result inspector stays read-only on an editable result

- **WHEN** the result is editable and the user selects one row
- **THEN** the inspector shows the row's fields with no editable inputs and no bulk-edit affordance

#### Scenario: Copy selected rows from the result grid

- **WHEN** the user selects rows 2–4 in the result grid and presses ⌘C
- **THEN** those three rows are copied to the clipboard as TSV

#### Scenario: Copy reflects a pending edit

- **WHEN** the user has a pending edit changing `email` to `ana@example.com` on row 2 and copies that row with ⌘C
- **THEN** the copied TSV contains `ana@example.com`, not the server value

#### Scenario: Affected result renders the compact summary

- **WHEN** an INSERT returns `{ kind: "affected", command_tag: "INSERT 0 3", affected_rows: 3, query_ms: 12 }`
- **THEN** the panel shows `INSERT 0 3 · 3 rows affected · 12 ms`
- **AND** no grid is rendered

#### Scenario: Truncation banner surfaces above the grid

- **WHEN** a streaming SELECT reaches its `done` event with `truncated: true`, `row_cap: 10000`, `row_cap_source: "setting"`
- **THEN** a banner reads `Showing the first 10,000 rows — the result hit Argus's row limit. Raise the limit or add a LIMIT clause.` above the grid
- **AND** it offers a **Raise limit** action

#### Scenario: Truncation banner names a raised cap

- **WHEN** a run comes back with `truncated: true`, `row_cap: 100000`, `row_cap_source: "setting"`
- **THEN** the banner names `100,000` rows, not `10,000`

#### Scenario: Truncated editable result is still editable

- **WHEN** a run comes back `truncated: true` with `editability.status: "editable"` on a writable connection
- **THEN** the returned rows can be edited and saved normally
- **AND** the truncation banner is shown above the grid

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

Each `postgres-query` tab SHALL display a status indicator inside the tab's chrome (between editor and result panel, or in the panel header). The indicator MUST show: the latest run's elapsed time (`12 ms`) and the latest run's outcome summary (`5 rows` or `3 rows affected` or `error`). When a run is in flight, the indicator MUST show the live elapsed-time text per the "Live elapsed-time indicator while running" requirement (i.e. `Running…` for the first second, then `Running… <s>s` up to a minute, then `Running… <m>:<ss>` past one minute). **For a streaming run in flight, the indicator MAY additionally reflect the live count of rows received so far; on completion it MUST show the final outcome summary using the terminal `done` event's `row_count` (and the truncation state when `truncated: true`).**

#### Scenario: Indicator updates after a successful run

- **WHEN** a SELECT completes returning 5 rows in 12 ms
- **THEN** the indicator reads `5 rows · 12 ms`

#### Scenario: Indicator shows running state with live elapsed time

- **WHEN** a run has been in flight for 2300ms and the response has not yet arrived
- **THEN** the indicator reads `Running… 2.3s`
- **AND** the text continues to tick approximately every 100ms until the run completes

#### Scenario: Indicator reflects the streamed row count on completion

- **WHEN** a streaming SELECT reaches `done` with `row_count: 5000` in 420 ms
- **THEN** the indicator reads `5000 rows · 420 ms`

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

The Postgres module SHALL allow a user-initiated run (`postgres_run_sql` / `postgres_run_sql_stream` / `postgres_run_sql_many`) to be cancelled. The run command SHALL accept a frontend-generated `run_token`, register its `client.cancel_token()` in the shared in-flight registry under that token, and on `cancel_running_query(run_token)` fire the cancel token (Postgres cancel-request protocol) so the server aborts the statement. The run SHALL then resolve as cancelled. The editor SHALL present a Stop control and cancel shortcut while running and return to idle on cancel.

For a **streaming** run, cancellation MUST stop pulling further rows from the server and MUST resolve the run to the neutral cancelled state without emitting an `error` terminal event. The rows already delivered via prior `batch` events MUST remain visible in the grid (they are valid rows the user asked to inspect); the `Loading…` progress indicator MUST clear and the status indicator MUST return to idle / show the cancelled state.

#### Scenario: User cancels a long-running statement

- **WHEN** a `SELECT pg_sleep(30)` is running and the user clicks Stop (or presses the cancel shortcut)
- **THEN** `cancel_running_query` fires the connection's cancel token, the server aborts the query, and the editor returns to idle showing "Query cancelled"
- **AND** no result rows and no error block are displayed

#### Scenario: Cancelling a streaming run keeps rows already delivered

- **WHEN** a streaming `SELECT * FROM big_table` has delivered 2,400 rows across several `batch` events and the user clicks Stop
- **THEN** the backend stops fetching further rows and the run resolves to the neutral cancelled state (no `error` event)
- **AND** the 2,400 rows already delivered remain visible in the grid
- **AND** the `Loading…` progress indicator clears and the editor returns to idle

#### Scenario: Cancel during a multi-statement run

- **WHEN** the user cancels while `postgres_run_sql_many` is executing statement *k*
- **THEN** the in-flight statement is aborted, the batch stops, and the whole run resolves to the neutral cancelled state (no error block, no partial rows)

### Requirement: Streaming single-statement run

The Postgres module SHALL expose a Tauri command `postgres_run_sql_stream(connection_id, sql, origin?, run_token, on_event)` that executes exactly one SQL statement and delivers its result **incrementally** to the frontend over a `tauri::ipc::Channel` (`on_event`) instead of returning a single materialized `RunSqlResult`. The command MUST reuse the same statement classification, read-only enforcement, connection acquisition (from the existing pool registry, no new connection), and cancellation registration (`run_token` → `client.cancel_token()` in the in-flight registry) as `postgres_run_sql`.

For a statement that returns a row set, the command MUST fetch rows from the server as a **stream** (`tokio_postgres` `query_raw` / `RowStream`) and MUST NOT materialize the full result set in memory before emitting. It MUST emit, in order:

1. Exactly one **columns** event `{ event: "columns", columns: Array<ColumnInfo> }` as soon as the column metadata is known (before any rows), using the same `ColumnInfo` shape as `postgres_run_sql`.
2. One or more **batch** events `{ event: "batch", rows: Array<Array<Value>> }` as rows arrive. Each `rows` entry MUST use the same `Value` envelope handling for binary/truncated cells as `postgres_run_sql`. Batches MUST be flushed incrementally — a batch MUST be emitted when it reaches a bounded size (row count) OR a bounded time has elapsed since the last flush, whichever comes first — so the first rows reach the frontend without waiting for the whole set.
3. Exactly one terminal event: `{ event: "done", row_count: number, truncated: boolean, query_ms: number }` on success.

For a statement that returns no row set (DML/DDL), the command MUST emit exactly one terminal event `{ event: "affected", command_tag: string, affected_rows: number, query_ms: number }` and no columns/batch events.

If the statement fails — including a failure that occurs **after** some batches have already been emitted — the command MUST emit exactly one terminal event `{ event: "error", message: string, code?: string, position?: number }` carrying the same server-message/SQLSTATE/position detail as the non-streaming error envelope, and MUST NOT emit any event after a terminal event.

The command MUST enforce the same 10,000-row cap as `postgres_run_sql`: once 10,000 rows have been emitted it MUST stop pulling further rows from the server (drop the stream) and set `truncated: true` in the `done` event. `query_ms` MUST measure end-to-end from dispatch to the terminal event.

`origin` MUST be `"user"` or `"auto"` and defaults to `"user"`. Multi-statement runs (`postgres_run_sql_many`) are out of scope and continue to use the non-streaming path.

#### Scenario: Columns arrive before rows

- **WHEN** the frontend runs `SELECT id, email FROM users` via `postgres_run_sql_stream`
- **THEN** the first event on the channel is `{ event: "columns", columns: [id, email] }`
- **AND** it is emitted before any `batch` event

#### Scenario: Rows are delivered in incremental batches

- **WHEN** a SELECT returns 5,000 rows
- **THEN** the channel receives multiple `batch` events whose `rows` arrays concatenate to all 5,000 rows in server order
- **AND** the first `batch` event is emitted before the query has finished fetching the full set
- **AND** the terminal event is `{ event: "done", row_count: 5000, truncated: false, query_ms: <n> }`

#### Scenario: Streaming stops at the 10,000-row cap

- **WHEN** a SELECT against a 1M-row table runs without LIMIT via `postgres_run_sql_stream`
- **THEN** the concatenated `batch` rows total exactly 10,000
- **AND** the backend stops pulling further rows from the server
- **AND** the terminal event is `{ event: "done", row_count: 10000, truncated: true, query_ms: <n> }`

#### Scenario: DML statement emits a single affected event

- **WHEN** an `INSERT ... ` affecting 3 rows runs via `postgres_run_sql_stream`
- **THEN** the only event is `{ event: "affected", command_tag: "INSERT 0 3", affected_rows: 3, query_ms: <n> }`
- **AND** no `columns` or `batch` event is emitted

#### Scenario: Error after partial rows emits a terminal error event

- **WHEN** a query errors mid-stream after some `batch` events have already been delivered
- **THEN** the channel receives a terminal `{ event: "error", message, code?, position? }` event
- **AND** no further events are emitted on the channel

#### Scenario: Read-only connection rejects a mutating statement before streaming

- **WHEN** the connection has `params.read_only: true` and the user runs an `UPDATE` via `postgres_run_sql_stream`
- **THEN** the command returns/emits the read-only validation error and no `batch` event is emitted

### Requirement: Postgres run responses carry the effective row cap

`postgres_run_sql`, each `status: "ok"` outcome of `postgres_run_sql_many`, and the
`postgres_run_sql_stream` terminal `done` event SHALL each carry two additional fields on their
rows-shaped payload, per the `sql-result-row-cap` capability:

- `row_cap: number` — the effective cap applied to that statement.
- `row_cap_source: "setting" | "hard_ceiling" | "engine"` — which constraint was binding.

For Postgres the engine ceiling is `HARD_ROW_CAP`, so `row_cap_source` is never `"engine"`.
The fields are additive: `columns`, `rows`, `truncated_columns`, `truncated`, `query_ms` and the
`RunSqlResult` / `StreamEvent` discriminants are otherwise unchanged.

#### Scenario: Single run reports its cap

- **WHEN** `postgres_run_sql` returns a rows result with `sql.rowCap` at `10000` and no statement limit
- **THEN** the response includes `row_cap: 10000` and `row_cap_source: "setting"`

#### Scenario: Streaming done event reports its cap

- **WHEN** a `postgres_run_sql_stream` run of `SELECT * FROM t LIMIT 30000` terminates with `sql.rowCap` at 10,000
- **THEN** the `done` event includes `row_cap: 30000`, `row_cap_source: "setting"`, and `truncated: false`

### Requirement: Postgres single-statement fetch stops at the cap

`run_one` (the non-streaming path used by `postgres_run_sql` and every step of
`postgres_run_sql_many`) SHALL fetch rows incrementally via `query_raw` and stop pulling from the
server as soon as the effective cap is reached, in the same way `run_one_stream` already does.
It MUST NOT materialize the complete server-side result set and trim it afterwards.

This is a prerequisite for any effective cap above the previous fixed 10,000: peak memory MUST
be bounded by the effective cap, not by the query's true cardinality.

#### Scenario: Non-streaming run does not materialize past the cap

- **WHEN** `postgres_run_sql` runs `SELECT * FROM one_million_rows` with an effective cap of 10,000
- **THEN** at most 10,000 rows are ever held in memory for that statement
- **AND** the response has `rows.length === 10000` and `truncated: true`

### Requirement: Postgres run responses carry result editability

`postgres_run_sql`, each `status: "ok"` outcome of `postgres_run_sql_many`, and the
`postgres_run_sql_stream` `columns` event SHALL each carry one additional field on
their rows-shaped payload, per the `sql-result-editability` capability:

- `editability: ResultEditability` — either
  `{ status: "editable", schema, relation, pk_columns, pk_column_indexes, column_sources, enums }`
  or `{ status: "not_editable", reason }`.

The field is additive: `columns`, `rows`, `truncated_columns`, `truncated`,
`query_ms`, `row_cap`, `row_cap_source` and the `RunSqlResult` / `StreamEvent`
discriminants are otherwise unchanged. `kind: "affected"` results and the
`affected` / `done` / `error` stream events MUST NOT carry the field.

Provenance MUST be derived from the prepared statement's `RowDescription`
(`tokio_postgres::Column::table_oid()` / `column_id()`) rather than by parsing the
SQL text. Because OIDs are absolute, the resolved `schema` MUST be the relation's
real schema even when the statement referenced it unqualified through
`search_path`.

The relation is considered editable only when its `pg_class.relkind` is `'r'`
(ordinary table) or `'p'` (partitioned table).

#### Scenario: Single run of a keyed table reports editable

- **WHEN** `postgres_run_sql(id, "SELECT id, email FROM users", "user")` runs against `public.users` with PK `(id)`
- **THEN** the response includes `editability: { status: "editable", schema: "public", relation: "users", pk_columns: ["id"], pk_column_indexes: [0], column_sources: ["id", "email"], enums: {} }`

#### Scenario: Streaming columns event carries editability

- **WHEN** a `postgres_run_sql_stream` run of `SELECT id, email FROM users` emits its `columns` event
- **THEN** that event includes the `editability` field
- **AND** neither the `batch` nor the `done` event repeats it

#### Scenario: Each multi-statement outcome carries its own editability

- **WHEN** `postgres_run_sql_many(id, ["SELECT id FROM users", "SELECT count(*) FROM users"], "user")` runs
- **THEN** the first `status: "ok"` outcome carries `editability.status: "not_editable"` with `reason: "pk_not_selected"` or `"editable"` per the projection
- **AND** the second carries `editability: { status: "not_editable", reason: "no_base_table" }`

#### Scenario: Unqualified table name resolves to its real schema

- **WHEN** the connection's `search_path` is `app, public` and the user runs `SELECT id FROM users`, resolving to `app.users`
- **THEN** `editability.schema` is `"app"`

#### Scenario: Affected result carries no editability field

- **WHEN** `postgres_run_sql(id, "UPDATE users SET active = false", "user")` runs against a writable connection
- **THEN** the response is `{ kind: "affected", … }` with no `editability` key

#### Scenario: Editability resolution does not change run timing semantics

- **WHEN** the editability resolver's catalog query fails or times out during a `SELECT * FROM users` run
- **THEN** the run still returns `kind: "rows"` with its rows and `query_ms`
- **AND** `editability` is `{ status: "not_editable", reason: "no_base_table" }`

### Requirement: Inline cell editing in the SQL editor result grid

The result panel SHALL offer inline cell editing on a rows result when **all** of
the following hold:

1. the run is a single-statement run (not a `Run all` / multi-statement run),
2. the run has reached its terminal state (not streaming in flight),
3. the response's `editability.status` is `"editable"`, and
4. the tab's current connection is not `read_only`.

When those conditions hold, the panel MUST render `<AdhocResultGrid />` with its
edit configuration supplied, so that double-clicking a cell opens the same inline
editor the table viewer uses (per `postgres-data-edit`, "Editable mode in the data
viewer"): typed input coercion, explicit NULL toggle for nullable columns, enum
`<select>` for enum columns, JSON/JSONB validation on commit, `Enter`/`Tab` to
commit, `Escape` to cancel, and a dirty-cell highlight.

The following cells MUST stay read-only even on an editable result:

- any cell whose `column_sources` entry is `null` (computed / aliased expression),
- any cell whose base column is one of `pk_columns` (the row's identity),
- `bytea` columns and any cell whose value arrived as a `{ kind: "binary" | "truncated" }` envelope.

Row insertion and row deletion MUST NOT be offered in this grid: there is no `+`
gutter affordance, no "Add row" control, and `Backspace` / `Delete` MUST NOT mark
rows for deletion. Cell UPDATE is the only supported operation.

#### Scenario: Double-click opens the editor on an editable result

- **WHEN** the user runs `SELECT id, email FROM users` on a writable connection and double-clicks an `email` cell
- **THEN** an inline text editor opens with the current value selected

#### Scenario: Commit marks the cell dirty

- **WHEN** the user edits that `email` cell to `ana@example.com` and presses `Enter`
- **THEN** the editor closes, the cell shows `ana@example.com` with the dirty highlight
- **AND** the panel's pending-edit count reads `1`

#### Scenario: Escape cancels without dirtying

- **WHEN** the user opens the editor on a cell, types a new value, and presses `Escape`
- **THEN** the cell reverts to its server value with no dirty highlight
- **AND** the pending-edit count is unchanged

#### Scenario: Opening and closing the editor unchanged does not dirty the cell

- **WHEN** the user double-clicks a cell and presses `Enter` without changing anything
- **THEN** no pending edit is recorded

#### Scenario: Primary-key cells are not editable

- **WHEN** the user double-clicks the `id` cell of a result from `SELECT id, email FROM users`
- **THEN** no editor opens
- **AND** the cell's hover title reads `Primary key — not editable`

#### Scenario: Computed columns are not editable

- **WHEN** the result came from `SELECT id, email, upper(email) AS shout FROM users` and the user double-clicks a `shout` cell
- **THEN** no editor opens
- **AND** the cell's hover title reads `Computed column — not editable`

#### Scenario: Enum column offers a select

- **WHEN** the user double-clicks a cell of an enum-typed base column
- **THEN** the editor is a `<select>` listing that enum's labels in declared order

#### Scenario: Insert and delete are not offered

- **WHEN** an editable result is displayed and the user selects a row and presses `Backspace`
- **THEN** no row is marked for deletion
- **AND** no "Add row" control is rendered anywhere in the result panel

### Requirement: Non-editable result cells explain themselves on hover

When a rows result is displayed but inline editing is not available, every data
cell SHALL carry a `title` tooltip naming the reason, so a double-click that does
nothing is explained rather than silent. The copy MUST be derived from the response's
`editability.reason` (or from local state for the two client-side cases):

| Condition | Hover copy |
| --- | --- |
| `no_base_table` | `Not editable — this result isn't a plain table projection` |
| `multiple_tables` | `Not editable — the result mixes columns from more than one table` |
| `not_a_table` | `Not editable — views and materialized views can't be edited here` |
| `no_primary_key` | `Not editable — <schema>.<relation> has no primary key` |
| `pk_not_selected` | `Not editable — add the primary key to the SELECT list to edit these rows` |
| `duplicate_projection` | `Not editable — the same column is selected more than once` |
| connection is `read_only` | `Read-only connection — edits disabled` |
| multi-statement run | `Not editable — results from a multi-statement run are read-only` |
| streaming still in flight | `Not editable while the query is still loading` |

Double-clicking a non-editable cell MUST NOT open an editor, MUST NOT emit a toast,
and MUST NOT change the selection state beyond what a single click already does.

#### Scenario: Missing primary key names the fix

- **WHEN** the user runs `SELECT email FROM users` (PK `id` not selected) and hovers a cell
- **THEN** the tooltip reads `Not editable — add the primary key to the SELECT list to edit these rows`

#### Scenario: Join result explains the mix

- **WHEN** the user runs `SELECT u.id, o.total FROM users u JOIN orders o ON o.user_id = u.id` and hovers a cell
- **THEN** the tooltip reads `Not editable — the result mixes columns from more than one table`

#### Scenario: Read-only connection takes precedence over the wire reason

- **WHEN** the connection is `read_only` and the result's `editability.status` is `"editable"`
- **THEN** every cell's tooltip reads `Read-only connection — edits disabled`
- **AND** no editor opens on double-click

#### Scenario: Double-click on a non-editable cell is inert

- **WHEN** the user double-clicks a cell of a non-editable result
- **THEN** no editor opens, no toast appears, and no error is logged

### Requirement: Save and discard pending result-grid edits

While the result grid holds pending edits, the result panel header SHALL render a
`Discard` control and a `Save (<n>)` control beside the existing export menu, where
`<n>` is the number of dirty rows. `Save` MUST render disabled (labelled `Save`)
when the buffer is clean, and MUST NOT render at all when the result is not
editable. **No keyboard shortcut is bound to this action** — `⌘S` in a query tab
continues to save the *query*, unchanged.

`Save` MUST commit through the existing `postgres_apply_table_edits(connection_id,
schema, relation, edits, "user")` command from `postgres-data-edit`, using the
`schema` and `relation` from the response's `editability` payload and one
`{ kind: "update", pk, changes }` op per dirty row. `changes` MUST be keyed by base
column name.

On `outcome: "ok"` the panel MUST clear the buffer and re-run the same statement —
with its original SQL text and editor start offset preserved — so the user sees
committed values. On `outcome: "op_failed"` the panel MUST show a dismissable banner
above the grid reading `Op #<1-based index> failed: [<code>] <message>` and MUST
leave the buffer intact so the user can correct and retry. A thrown `AppError` MUST
surface on the same banner using its message.

`Discard` MUST clear the buffer without confirmation when it is invoked directly by
the user from this control.

#### Scenario: Save commits and refreshes

- **WHEN** the user has two dirty rows in an editable result and clicks `Save (2)`
- **THEN** `postgres_apply_table_edits` is invoked once with two `update` ops and `origin: "user"`
- **AND** on success the pending-edit count returns to zero and the same statement is re-run

#### Scenario: Re-run after save preserves the statement offset

- **WHEN** a save succeeds for a result produced by the second statement in the editor document
- **THEN** the re-run executes that same statement text
- **AND** a subsequent syntax error's "Show in editor" still jumps to that statement's original offset

#### Scenario: Op failure keeps the buffer

- **WHEN** the apply returns `{ outcome: "op_failed", failed_op_index: 0, code: "23505", message: "duplicate key value violates unique constraint" }`
- **THEN** a banner above the grid reads `Op #1 failed: [23505] duplicate key value violates unique constraint`
- **AND** the two dirty cells remain dirty and editable

#### Scenario: Save is absent on a non-editable result

- **WHEN** the result's `editability.status` is `"not_editable"`
- **THEN** neither `Save` nor `Discard` is rendered in the result header

#### Scenario: Cmd-S still saves the query

- **WHEN** the result grid holds pending edits and the user presses `⌘S`
- **THEN** the query-save flow runs as before
- **AND** the result-grid buffer is untouched

#### Scenario: Discard clears the buffer

- **WHEN** the user clicks `Discard` with three dirty rows
- **THEN** all cells revert to their server values and the count returns to zero

### Requirement: Pending result-grid edits are guarded against loss

A dirty result-grid buffer SHALL be treated with the same care as a dirty
table-viewer buffer. While the buffer holds pending edits, the query tab MUST:

- publish a dirty-summary entry for the tab (label `<schema>.<relation> (result)`)
  so the disconnect-confirmation dialog can name what would be lost,
- intercept tab close and show the shared discard-confirmation dialog rather than
  closing directly,
- intercept a new run (`⌘↩`, `Run all`, or the post-save re-run's user-initiated
  equivalent) and show the same dialog, and
- intercept a connection switch in the tab's connection selector and show the same
  dialog.

Confirming the dialog discards the buffer and proceeds with the requested action.
Cancelling leaves both the buffer and the current result untouched. The re-run that
the panel performs itself immediately after a successful save is NOT a user-initiated
run and MUST NOT prompt.

#### Scenario: Closing the tab with pending edits prompts

- **WHEN** the user closes a query tab whose result grid has one dirty row
- **THEN** the discard-confirmation dialog appears and the tab stays open
- **AND** confirming discards the edits and closes the tab

#### Scenario: Re-running with pending edits prompts

- **WHEN** the user presses `⌘↩` with two dirty rows in the result grid
- **THEN** the discard-confirmation dialog appears and the query is not dispatched
- **AND** cancelling leaves the two dirty rows intact

#### Scenario: Switching connection with pending edits prompts

- **WHEN** the user picks a different connection in the toolbar selector with pending result edits
- **THEN** the discard-confirmation dialog appears before the connection changes

#### Scenario: Post-save re-run does not prompt

- **WHEN** a save succeeds and the panel re-runs the statement
- **THEN** no discard dialog appears

#### Scenario: Dirty result buffer is named in the disconnect dialog

- **WHEN** the result grid of a query tab against `public.users` has pending edits and the user disconnects that connection
- **THEN** the confirmation dialog names `public.users (result)`
### Requirement: Exact NUMERIC cell decoding

For `kind: "rows"` results, every cell of a `numeric` / `decimal` column (Postgres
OID `NUMERIC`) SHALL be returned as a JSON **string** holding the value's exact
decimal text, byte-for-byte equivalent to what Postgres' own `numeric_out` would
produce for that value and `dscale`. The decoder MUST operate on the binary wire
format (`tokio-postgres` requests binary result format for every column) and MUST
NOT route the value through `f64`, `f32`, or any fixed-width decimal type, so
arbitrary precision and trailing scale are preserved exactly.

The decoder MUST honour the declared scale (`dscale`): the fractional part is
rendered to exactly `dscale` digits, zero-padded or truncated as needed, and no
decimal point is emitted when `dscale` is `0`. The special sign encodings MUST
render as `"NaN"`, `"Infinity"` and `"-Infinity"`.

A malformed or short `NUMERIC` payload MUST NOT panic; the decoder MUST fail
cleanly and let the cell fall through to the undecodable-cell fallback.

This requirement also applies to `numeric` reached through a domain, an array
element, or a range bound.

#### Scenario: numeric column renders its value, not a placeholder

- **WHEN** the user runs `SELECT 1234.56::numeric` in the Postgres SQL editor
- **THEN** the cell value is the string `"1234.56"`
- **AND** no cell in the result equals `"<numeric>"`

#### Scenario: declared scale is preserved

- **WHEN** the user runs `SELECT 1234.56::numeric(10,4)`
- **THEN** the cell value is the string `"1234.5600"`

#### Scenario: zero scale renders without a decimal point

- **WHEN** the user runs `SELECT 42::numeric(10,0)`
- **THEN** the cell value is the string `"42"`

#### Scenario: arbitrary precision survives without f64 rounding

- **WHEN** the user runs `SELECT '-12345678901234567890.123456789'::numeric`
- **THEN** the cell value is the string `"-12345678901234567890.123456789"`

#### Scenario: small magnitudes with leading zero groups

- **WHEN** the user runs `SELECT 0.00001::numeric`
- **THEN** the cell value is the string `"0.00001"`

#### Scenario: NaN and infinities render as Postgres spells them

- **WHEN** the user runs `SELECT 'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric`
- **THEN** the cell values are the strings `"NaN"`, `"Infinity"` and `"-Infinity"`

#### Scenario: zero with scale

- **WHEN** the user runs `SELECT 0::numeric(10,2)`
- **THEN** the cell value is the string `"0.00"`

#### Scenario: malformed numeric payload does not panic

- **WHEN** the `NUMERIC` decoder is given a payload shorter than its declared digit count
- **THEN** it returns an error rather than panicking
- **AND** the cell falls through to the undecodable-cell fallback

### Requirement: Decoding of previously unsupported scalar types

For `kind: "rows"` results, the following Postgres types SHALL be decoded to their
value rather than a type placeholder:

- `money` → decimal string with two fractional digits, no currency symbol and no
  thousands separators (e.g. `"-12345.67"`). The two-digit scale is an assumption
  about the server's `lc_monetary` `frac_digits`, which is not carried on the wire.
- `timetz` → `HH:MM:SS[.ffffff]±HH:MM`, where the offset is the UTC offset (the
  wire field is seconds *west* of UTC and MUST be negated for display).
- `bit` / `varbit` → a string of `'0'`/`'1'` characters whose length equals the
  value's declared bit length.
- `point` → `(x,y)`; `lseg` → `[(x1,y1),(x2,y2)]`; `box` → `(x1,y1),(x2,y2)`;
  `line` → `{A,B,C}`; `path` → `((x1,y1),…)` when closed and `[(x1,y1),…]` when
  open; `polygon` → `((x1,y1),…)`; `circle` → `<(x,y),r>`.

Each decoder MUST validate payload length before reading and MUST fail cleanly
(never panic) on a short or malformed buffer.

#### Scenario: money renders its amount

- **WHEN** the user runs `SELECT (-12345.67)::money`
- **THEN** the cell value is the string `"-12345.67"`
- **AND** it is not `"<money>"`

#### Scenario: timetz renders time and UTC offset

- **WHEN** the user runs `SELECT '12:34:56.789+02'::timetz`
- **THEN** the cell value is the string `"12:34:56.789000+02:00"`

#### Scenario: varbit renders its bits

- **WHEN** the user runs `SELECT B'1011'::varbit`
- **THEN** the cell value is the string `"1011"`

#### Scenario: point renders in Postgres text form

- **WHEN** the user runs `SELECT '(1,2)'::point`
- **THEN** the cell value is the string `"(1,2)"`

#### Scenario: malformed geometric payload does not panic

- **WHEN** a geometric decoder is given a buffer shorter than its fixed width
- **THEN** it returns an error rather than panicking

### Requirement: Recursive decoding of arrays, ranges, and domains

For `kind: "rows"` results, container-kind Postgres types SHALL be decoded by
recursing into their element or base type, so any type covered elsewhere in this
capability is also covered inside a container:

- **Arrays** (`Kind::Array`) MUST decode to a JSON array. A SQL `NULL` element
  MUST become JSON `null`. An empty array MUST become `[]`. A multi-dimensional
  array MUST be nested according to its dimension lengths. An element whose own
  decode fails MUST become `null` rather than failing the whole cell.
- **Ranges** (`Kind::Range`) MUST decode to Postgres' text form: `"empty"` for the
  empty range, otherwise `[lo,hi)`-style with the bracket/parenthesis reflecting
  inclusivity and an infinite bound written as the empty string. Each finite bound
  MUST be rendered by decoding it as the range's base type.
- **Multiranges** (`Kind::Multirange`) MUST decode to `{[a,b),[c,d)}` over their
  constituent ranges, and `{}` when empty.
- **Domains** (`Kind::Domain`) MUST decode as their underlying base type, since a
  domain shares its base type's wire format.

Recursion depth MUST be bounded; a value nested beyond the bound MUST fall through
to the undecodable-cell fallback rather than exhausting the stack.

#### Scenario: integer array decodes to a JSON array

- **WHEN** the user runs `SELECT ARRAY[1,2,NULL]::int4[]`
- **THEN** the cell value is the JSON array `[1, 2, null]`
- **AND** it is not `"<_int4>"`

#### Scenario: text array decodes to a JSON array of strings

- **WHEN** the user runs `SELECT ARRAY['a','b']::text[]`
- **THEN** the cell value is the JSON array `["a", "b"]`

#### Scenario: numeric array preserves exact values

- **WHEN** the user runs `SELECT ARRAY[1.10, 2.20]::numeric(10,2)[]`
- **THEN** the cell value is the JSON array `["1.10", "2.20"]`

#### Scenario: empty array decodes to an empty JSON array

- **WHEN** the user runs `SELECT ARRAY[]::int4[]`
- **THEN** the cell value is the JSON array `[]`

#### Scenario: multi-dimensional array nests

- **WHEN** the user runs `SELECT ARRAY[[1,2],[3,4]]::int4[][]`
- **THEN** the cell value is the JSON array `[[1, 2], [3, 4]]`

#### Scenario: range decodes to its text form

- **WHEN** the user runs `SELECT '[1,5)'::int4range`
- **THEN** the cell value is the string `"[1,5)"`

#### Scenario: empty range decodes to empty

- **WHEN** the user runs `SELECT 'empty'::int4range`
- **THEN** the cell value is the string `"empty"`

#### Scenario: unbounded range renders an empty bound

- **WHEN** the user runs `SELECT '[1,)'::int4range`
- **THEN** the cell value is the string `"[1,)"`

#### Scenario: domain decodes as its base type

- **WHEN** the user runs a `SELECT` returning a column of a domain declared over
  `numeric(10,2)` whose value is `1.50`
- **THEN** the cell value is the string `"1.50"`

#### Scenario: domain over text decodes as text

- **WHEN** the user runs a `SELECT` returning a column of a domain declared over
  `text` whose value is `abc`
- **THEN** the cell value is the string `"abc"`

### Requirement: Undecodable cell fallback

The Postgres SQL editor SHALL NOT return a `<typename>` placeholder for any cell.
When a cell's Postgres type has no decoder, the backend MUST fall back, in order,
to:

1. The raw payload interpreted as UTF-8, returned as a JSON string, when the bytes
   are valid UTF-8 **and** contain no control characters other than tab, newline
   and carriage return — correct for types whose binary representation is their
   text representation (`xml`, `ltree`, `pg_lsn`, unrecognised extension text
   types). The control-character guard is what keeps a structured binary payload
   that merely happens to be valid UTF-8 (`tsvector` is length-prefixed) from
   rendering as a run of escapes; Postgres `text` cannot contain a NUL byte, so
   the guard never rejects a real text value.
2. The existing binary envelope `{ kind: "binary", preview: <hex>, byte_length: <n> }`
   — the same shape already returned for `bytea` — with the column name recorded
   in the response's `truncated_columns`.

A SQL `NULL` MUST still return JSON `null` and MUST NOT enter this fallback chain.

Size limits are applied after decoding, matching the existing behaviour: a decoded
string longer than the inline-truncate limit MUST be returned as the existing
`{ kind: "truncated", preview, byte_length }` envelope with its column recorded in
`truncated_columns`, and a decoded container value whose JSON serialisation
exceeds the same limit MUST be returned as that truncated envelope over the
serialised preview.

The types already decoded before this change — `bool`, `int2`/`int4`/`int8`,
`float4`/`float8`, `json`/`jsonb`, `bytea`, `date`, `time`, `timestamp`,
`timestamptz`, `uuid`, `oid`, `xid`, `xid8`, `interval`, `inet`/`cidr`,
`macaddr`/`macaddr8`, and the text family — MUST keep their current JSON shapes,
including their truncation and binary envelopes.

#### Scenario: no placeholder is ever emitted

- **WHEN** any `SELECT` completes in the Postgres SQL editor
- **THEN** no cell value matches the pattern `<typename>` produced by the former
  last-resort branch

#### Scenario: unknown text-shaped type falls back to UTF-8

- **WHEN** the user runs `SELECT '<a/>'::xml`
- **THEN** the cell value is the string `"<a/>"`

#### Scenario: unknown binary-shaped type falls back to the binary envelope

- **WHEN** the user runs a `SELECT` returning a column of a type with no decoder
  whose payload is not valid printable UTF-8 — e.g. `'tsv'::tsvector`, whose
  length-prefixed payload is valid UTF-8 but riddled with NUL bytes
- **THEN** the cell value is `{ kind: "binary", preview: <hex prefix>, byte_length: <n> }`
- **AND** the column name appears in the response's `truncated_columns`

#### Scenario: NULL stays null

- **WHEN** the user runs `SELECT NULL::numeric, NULL::int4[], NULL::money`
- **THEN** every cell value is JSON `null`

#### Scenario: previously working types are unchanged

- **WHEN** the user runs `SELECT true, 1::int4, 1.5::float8, '{"a":1}'::jsonb, now(), gen_random_uuid()`
- **THEN** the cells are, respectively, JSON `true`, JSON `1`, JSON `1.5`, the JSON
  object `{"a":1}`, an RFC 3339 string, and a UUID string — the same shapes as
  before this change

### Requirement: Decoding applies to every rows-returning Postgres run path

The decoding rules in this capability SHALL apply identically to
`postgres_run_sql`, to each rows-returning statement of `postgres_run_sql_many`,
and to the `batch` events of `postgres_run_sql_stream`, since all three build cells
through the same conversion.

#### Scenario: multi-statement run decodes numeric in every statement

- **WHEN** the user invokes `postgres.runSqlMany(id, ["SELECT 1.50::numeric", "SELECT 2.50::numeric"], "user")`
- **THEN** entry 0's first cell is `"1.50"` and entry 1's first cell is `"2.50"`

#### Scenario: streaming run decodes numeric in batch events

- **WHEN** the user runs a streaming `SELECT` over a `numeric` column
- **THEN** every `batch` event's cells hold the exact decimal strings, not `"<numeric>"`

