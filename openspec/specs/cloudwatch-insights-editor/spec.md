# cloudwatch-insights-editor Specification

## Purpose
TBD - created by archiving change add-cloudwatch-connection. Update Purpose after archive.
## Requirements
### Requirement: Insights editor with out-of-query parameters

The CloudWatch Insights editor SHALL provide a CodeMirror body for the `.cwlogs` query string **plus a toolbar** carrying the two parameters that Logs Insights takes outside the query string: a **multi-select of log groups** (the query target, up to 50) and a **time-range picker**. The time-range picker SHALL offer relative presets (at least `5m`, `15m`, `1h`, `3h`, `12h`, `1d`, `1w`) and a custom absolute range. Relative presets MUST be resolved to concrete epoch-second `start_time`/`end_time` at the moment the query is run (not when the preset is selected), so a re-run uses a fresh window. The default selection is the log groups selected in the connection's tree (or empty) and the `1h` relative range.

#### Scenario: Toolbar carries log groups and time range

- **WHEN** the user opens an Insights editor for a connected CloudWatch connection
- **THEN** the toolbar shows a log-group multi-select and a time-range picker, with the query body in the CodeMirror editor below

#### Scenario: Relative preset resolves at run time

- **WHEN** the user selects the `1h` preset and runs the query twice a few minutes apart
- **THEN** each run sends `start_time`/`end_time` computed from the current clock at run time, so the second run covers a later window

#### Scenario: Running requires at least one log group

- **WHEN** the user runs an Insights query with no log group selected
- **THEN** the run is rejected before `StartQuery` with a validation message and no AWS call is made

### Requirement: Insights query lifecycle

The CloudWatch module SHALL expose `cloudwatch_run_insights(connection_id, log_group_identifiers, start_time, end_time, query_string, limit?, origin?)` that runs the Logs Insights lifecycle: `StartQuery` → poll `GetQueryResults` with bounded backoff and a total timeout → terminal-status handling. On status `Complete` it returns the results; on `Failed`, `Cancelled`, or `Timeout` it returns `AppError::Aws` carrying the status verbatim. The command MUST validate `start_time < end_time` and at least one log group before calling AWS, emit exactly one `argus:activity-log` event (default `origin: "user"`), and emit a `cloudwatch:query-started` event carrying the `query_id` so the frontend can cancel. A companion command `cloudwatch_cancel_insights(connection_id, query_id)` SHALL call `StopQuery`.

#### Scenario: Successful query returns rows

- **WHEN** the user runs a valid Insights query over a reachable log group and time range
- **THEN** the command polls until `Complete` and returns the result envelope with rows and statistics

#### Scenario: Failed query surfaces the status

- **WHEN** the Insights query reaches a `Failed` terminal status
- **THEN** the command returns `AppError::Aws` whose message includes the failure status, and no rows

#### Scenario: Cancel a running query

- **WHEN** a query is running and the user invokes `cloudwatch_cancel_insights(id, query_id)` with the `query_id` from the `cloudwatch:query-started` event
- **THEN** `StopQuery` is called and the in-flight run terminates without returning rows

#### Scenario: Empty time range rejected

- **WHEN** the command is invoked with `start_time >= end_time`
- **THEN** it returns `AppError::Validation` and makes no AWS call

### Requirement: Dynamic-column result shaping

Because Logs Insights returns `results` as per-row lists of `{ field, value }` with no fixed schema, the backend SHALL build the result column set as the **union of returned field names in order of first appearance**, with synthetic fields ordered first when present: `@timestamp`, then `@message`, then user fields, with `@ptr` last. Each row MUST be projected onto that column order, with a missing field rendered as `null`. All columns report `ty: "string"`. The result envelope SHALL be `Rows { columns: [{ name, ty }], rows: [[value]], query_ms, truncated, records_matched, records_scanned, bytes_scanned }`, with a fixed row cap setting `truncated: true` when exceeded. `records_matched` / `bytes_scanned` MUST be surfaced in the result panel as the per-run cost indicator.

#### Scenario: Ragged field sets unioned into stable columns

- **WHEN** one row returns fields `@timestamp, @message, level` and another returns `@timestamp, @message, requestId`
- **THEN** the column set is `@timestamp, @message, level, requestId` (synthetic first, then user fields in first-appearance order) and each row fills missing fields with `null`

#### Scenario: Cost shown per run

- **WHEN** an Insights query completes
- **THEN** the result panel shows `records_matched` and a human-readable `bytes_scanned` for that run

#### Scenario: Row cap truncates

- **WHEN** a query returns more rows than the fixed cap
- **THEN** the returned `rows` are capped and `truncated` is `true`

### Requirement: Insights result export

The Insights result panel SHALL offer CSV, JSONL, and XLSX export of the current result set, reusing the existing generic exporter (`columns:{name,ty}[] + rows[][]`) shared with the Athena and SQL engines. No CloudWatch-specific export code is added.

#### Scenario: Export the current result set

- **WHEN** the user exports a completed Insights result as CSV, JSONL, or XLSX
- **THEN** a file is written whose columns match the dynamic column set and whose rows match the displayed rows, via the shared exporter

### Requirement: Log-group selector searches the whole account

The Insights toolbar's log-group multi-select SHALL provide a text input that searches **all** of the account's log groups server-side as the user types, not only a preloaded page. Typing a term queries the backend (`cloudwatch_list_log_groups` with `name_pattern`) and renders the matching groups; an empty term shows the first page. Queries SHALL be debounced and a newer query SHALL supersede an in-flight one so results do not arrive out of order. The currently-selected groups SHALL remain selected and visible even when they fall outside the active search results, so a selection can be assembled across multiple searches. The ≤ 50-group selection cap is unchanged.

#### Scenario: Typing finds a group not in the initial list

- **WHEN** the account has hundreds of log groups, the dropdown initially shows the first page, and the user types a substring of a group that is not on that page
- **THEN** the dropdown shows the matching group(s) fetched from the backend and the user can select one

#### Scenario: Selection persists across searches

- **WHEN** the user has selected group A, then types a term that returns a result set not containing A, and selects group B from those results
- **THEN** both A and B are selected, and A remains visible as selected in the dropdown summary/list

#### Scenario: Clearing the search restores the first page

- **WHEN** the user clears the search input
- **THEN** the dropdown shows the first page of log groups again, with current selections still marked

#### Scenario: No matches shows an empty state

- **WHEN** the typed term matches no log group
- **THEN** the dropdown shows a "no matches" message and the current selection is unaffected

### Requirement: The query's own limit is honored

When the Insights query string contains a `limit` command (e.g. `| limit 100`), the run SHALL NOT send a `StartQuery` `limit` parameter, so the query's own limit governs the number of returned rows. When the query string contains no `limit` command, the run MAY apply a default limit, which MUST never exceed the client result row cap. The client row cap (with the `truncated` flag) remains the hard upper bound in all cases.

#### Scenario: Query limit is respected

- **WHEN** the user runs `fields @timestamp, @message | limit 100` over a log group with thousands of matching events
- **THEN** the result contains at most 100 rows (the query's limit), not the default

#### Scenario: Limitless query is still capped

- **WHEN** the user runs a query with no `limit` command that would match more rows than the client row cap
- **THEN** the result is capped at the row cap and `truncated` is `true`

### Requirement: Log-readable result rendering

The Insights result panel SHALL render results for readability as a log viewer, not a generic spreadsheet, following `DESIGN.md` (compact density, hairline borders, `--font-mono` data, single accent, no decorative gradients or thick borders). Specifically: a timestamp column SHALL be rendered as a fixed-width, human-readable local datetime with milliseconds; and any row SHALL be expandable to reveal its full message text, wrapped and selectable, with JSON values pretty-printed. Sorting, cell-copy, and export remain available.

#### Scenario: Timestamp is human-readable

- **WHEN** a result includes a `@timestamp` column
- **THEN** each timestamp renders as a local datetime down to milliseconds in a monospace, fixed-width column, with rows aligned

#### Scenario: Expand a row to read the full message

- **WHEN** the user clicks a result row whose `@message` is longer than the cell width
- **THEN** an inline detail view reveals the full message, wrapped and selectable, without truncation

#### Scenario: JSON messages are pretty-printed

- **WHEN** an expanded row's message is valid JSON
- **THEN** the detail view shows it pretty-printed (indented), not as a single unformatted line

#### Scenario: Export and sort are unaffected

- **WHEN** the user sorts by a column or exports the result while rows are expandable
- **THEN** sorting and CSV/JSONL/XLSX export behave exactly as before

