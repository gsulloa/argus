## MODIFIED Requirements

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
