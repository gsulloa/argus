## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Result panel for rows and affected outcomes

Each `postgres-query` tab SHALL render a result panel below the editor. The panel MUST:

- Render a hint state when no run has occurred yet in this tab. The hint MUST advertise both run and autocomplete shortcuts so the user discovers them on first use; the recommended copy is `Press ⌘↩ to run · Tab to autocomplete`.
- Render a virtualized read-only data grid (the `<AdhocResultGrid />` provided by `postgres-data-grid`) for `kind: "rows"` results, displaying the `columns` and `rows` from the response. **For a streaming run, the grid MUST render as soon as the `columns` event arrives and MUST append rows progressively as each `batch` event is received — the user sees the first rows without waiting for the run to complete.** The grid MUST support **row-range selection** (via a row-number gutter: plain click, shift-click, and drag) as well as single-cell selection, and the current row selection MUST drive the shell's right inspector (when the inspector is expanded) — a single-row selection shows one row, a multi-row selection shows all selected rows. The grid MUST support ⌘C / Ctrl+C copy (single cell or the selected row range as TSV), ⌘A / Ctrl+A select-all, and a read-only right-click context menu (Copy cell / Copy row(s)), per the `grid-cell-copy`, `grid-row-copy`, `grid-row-selection`, `grid-select-all`, and `grid-context-menu` capabilities. Column widths inside the grid MUST default to the type-derived base widths defined by `column-width-preferences` and MUST be user-resizable; resizing MUST NOT persist to disk across runs or sessions, but MUST persist within the same `<AdhocResultGrid />` instance for as long as the columns prop shape is unchanged.
- **While a streaming run is in flight, display a progress indicator above the grid showing the live count of rows received so far (e.g. `Loading… 3,412 rows`). The indicator MUST clear when the run reaches its terminal event.**
- Render a compact summary line for `kind: "affected"` results: `<command_tag> · <affected_rows> rows affected · <query_ms> ms`. Example: `INSERT 0 3 · 3 rows affected · 12 ms`.
- Display a banner above the grid `Result truncated at 10,000 rows — add a LIMIT clause to refine.` whenever the result is `truncated` (the streaming `done` event carries `truncated: true`).

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

#### Scenario: Progress indicator clears on completion

- **WHEN** a streaming SELECT reaches its `done` event with `row_count: 800`
- **THEN** the `Loading…` progress indicator is no longer shown
- **AND** the grid shows all 800 rows

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

- **WHEN** a streaming SELECT reaches its `done` event with `truncated: true`
- **THEN** a banner reads `Result truncated at 10,000 rows — add a LIMIT clause to refine.` above the grid

#### Scenario: Adhoc grid column widths reset when columns prop changes

- **WHEN** the user runs `SELECT id, email FROM users`, resizes `email` to 320px, then runs `SELECT id, email, status FROM users` in the same tab
- **THEN** the new result re-renders the grid with `id`, `email`, and `status` at their type-derived base widths
- **AND** the previous 320px override for `email` is discarded

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
