## ADDED Requirements

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

## MODIFIED Requirements

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

### Requirement: Result panel for rows and affected outcomes

Each `postgres-query` tab SHALL render a result panel below the editor. The panel MUST:

- Render a hint state when no run has occurred yet in this tab. The hint MUST advertise both run and autocomplete shortcuts so the user discovers them on first use; the recommended copy is `Press ⌘↩ to run · Tab to autocomplete`.
- Render a virtualized read-only data grid (the `<AdhocResultGrid />` provided by `postgres-data-grid`) for `kind: "rows"` results, displaying the `columns` and `rows` from the response. **For a streaming run, the grid MUST render as soon as the `columns` event arrives and MUST append rows progressively as each `batch` event is received — the user sees the first rows without waiting for the run to complete.** The grid MUST support **row-range selection** (via a row-number gutter: plain click, shift-click, and drag) as well as single-cell selection, and the current row selection MUST drive the shell's right inspector (when the inspector is expanded) — a single-row selection shows one row, a multi-row selection shows all selected rows. The grid MUST support ⌘C / Ctrl+C copy (single cell or the selected row range as TSV), ⌘A / Ctrl+A select-all, and a read-only right-click context menu (Copy cell / Copy row(s)), per the `grid-cell-copy`, `grid-row-copy`, `grid-row-selection`, `grid-select-all`, and `grid-context-menu` capabilities. Column widths inside the grid MUST default to the type-derived base widths defined by `column-width-preferences` and MUST be user-resizable; resizing MUST NOT persist to disk across runs or sessions, but MUST persist within the same `<AdhocResultGrid />` instance for as long as the columns prop shape is unchanged.
- **While a streaming run is in flight, display a progress indicator above the grid showing the live count of rows received so far (e.g. `Loading… 3,412 rows`). The indicator MUST clear when the run reaches its terminal event.**
- Render a compact summary line for `kind: "affected"` results: `<command_tag> · <affected_rows> rows affected · <query_ms> ms`. Example: `INSERT 0 3 · 3 rows affected · 12 ms`.
- Display the shared `<TruncationBanner />` above the grid whenever the result is `truncated`, per the `sql-result-row-cap` capability. The banner MUST name the response's `row_cap` rather than a hardcoded `10,000`. Once the streaming `done` event carries `truncated: true` the run reaches its terminal state and the banner renders exactly as it does for a non-streaming run; while a run is still in flight no banner is shown, since no cap information exists until that terminal event. Its dialect clause is `LIMIT`.

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

- **WHEN** a streaming SELECT reaches its `done` event with `truncated: true`, `row_cap: 10000`, `row_cap_source: "setting"`
- **THEN** a banner reads `Showing the first 10,000 rows — the result hit Argus's row limit. Raise the limit or add a LIMIT clause.` above the grid
- **AND** it offers a **Raise limit** action

#### Scenario: Truncation banner names a raised cap

- **WHEN** a run comes back with `truncated: true`, `row_cap: 100000`, `row_cap_source: "setting"`
- **THEN** the banner names `100,000` rows, not `10,000`

#### Scenario: Adhoc grid column widths reset when columns prop changes

- **WHEN** the user runs `SELECT id, email FROM users`, resizes `email` to 320px, then runs `SELECT id, email, status FROM users` in the same tab
- **THEN** the new result re-renders the grid with `id`, `email`, and `status` at their type-derived base widths
- **AND** the previous 320px override for `email` is discarded
