## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Bottom status indicator

Each `postgres-query` tab SHALL display a status indicator inside the tab's chrome (between editor and result panel, or in the panel header). The indicator MUST show: the latest run's elapsed time (`12 ms`) and the latest run's outcome summary (`5 rows` or `3 rows affected` or `error`). When a run is in flight, the indicator MUST show the live elapsed-time text per the "Live elapsed-time indicator while running" requirement (i.e. `Running…` for the first second, then `Running… <s>s` up to a minute, then `Running… <m>:<ss>` past one minute).

#### Scenario: Indicator updates after a successful run

- **WHEN** a SELECT completes returning 5 rows in 12 ms
- **THEN** the indicator reads `5 rows · 12 ms`

#### Scenario: Indicator shows running state with live elapsed time

- **WHEN** a run has been in flight for 2300ms and the response has not yet arrived
- **THEN** the indicator reads `Running… 2.3s`
- **AND** the text continues to tick approximately every 100ms until the run completes
