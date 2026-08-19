## ADDED Requirements

### Requirement: MySQL run responses carry the effective row cap

`mysql_run_sql` and each `outcome: "ok"` step of `mysql_run_sql_many` SHALL carry two additional
fields on their rows-shaped payload, per the `sql-result-row-cap` capability:

- `row_cap: number` — the effective cap applied to that statement.
- `row_cap_source: "setting" | "hard_ceiling" | "engine"` — which constraint was binding.

For MySQL the engine ceiling is `HARD_ROW_CAP`, so `row_cap_source` is never `"engine"`. The
fields are additive; `columns`, `rows`, `truncated_columns`, `truncated`, `query_ms` and the
`RunSqlResult` discriminants are otherwise unchanged.

#### Scenario: Single run reports its cap

- **WHEN** `mysql_run_sql` returns a rows result with `sql.rowCap` at `10000` and no statement limit
- **THEN** the response includes `row_cap: 10000` and `row_cap_source: "setting"`

## MODIFIED Requirements

### Requirement: Result row cap

`mysql_run_sql` and each step of `mysql_run_sql_many` SHALL cap the returned row set at the
**effective cap** resolved per statement by the `sql-result-row-cap` capability —
`min(HARD_ROW_CAP, max(configured_cap, explicit_statement_limit))`, where `configured_cap` comes
from the `sql.rowCap` setting (default 10,000) and `explicit_statement_limit` is the
`Dialect::MySql` result of `explicit_row_limit` (trailing depth-0 `LIMIT <int>`, or
`LIMIT <offset>, <count>` yielding `<count>`).

When a query produces more rows than the effective cap, the backend MUST return the first
`row_cap` rows in `rows`, MUST set `truncated: true` in the response, and MUST stop fetching
further rows from the server (drop the iterator / discard the remainder). The cap is
per-statement, not per-run. The backend MUST fetch up to `effective_cap + 1` rows and set
`truncated = (fetched > effective_cap)`, so a result landing exactly on the cap is reported
complete — see `sql-result-row-cap`, "Exactly-at-cap results are not truncated". The `query_ms` MUST measure end-to-end including the time spent
fetching the cap-many rows.

An explicit `LIMIT` in the statement MUST NOT be overridden downward: the effective cap is never
lower than the statement's own limit up to `HARD_ROW_CAP`.

`truncated` MUST report the row cap **only**. It MUST NOT be OR-ed with the per-cell
`INLINE_TRUNCATE_BYTES` envelope flag; per-cell truncation is reported exclusively through
`truncated_columns`, matching the Postgres editor.

#### Scenario: Query returning under cap is not truncated

- **WHEN** a SELECT returns 4,200 rows
- **THEN** the response has `rows.length === 4200` and `truncated: false`

#### Scenario: Query exceeding cap is truncated to 10,000 with marker

- **WHEN** a SELECT against a 1M-row table runs without LIMIT and `sql.rowCap` is 10,000
- **THEN** the response has `rows.length === 10000`, `truncated: true`, and `row_cap: 10000`
- **AND** the activity-log event metric is `{ kind: "items", value: 10000 }`

#### Scenario: Explicit LIMIT above the configured cap is honoured

- **WHEN** the user runs `SELECT * FROM big_table LIMIT 30000` against a table with more than 30,000 rows, with `sql.rowCap` at 10,000
- **THEN** the response has `rows.length === 30000`, `truncated: false`, and `row_cap: 30000`

#### Scenario: Two-argument LIMIT is honoured by its count

- **WHEN** the user runs `SELECT * FROM big_table LIMIT 1000, 25000`
- **THEN** the effective cap is 25,000 and the response is not truncated by the client

#### Scenario: Oversized cell no longer sets the row-cap flag

- **WHEN** a SELECT returns 3 rows and one cell exceeds the 1 MiB inline envelope
- **THEN** the response has `truncated: false` and `truncated_columns` names that column

### Requirement: Result panel for rows and affected outcomes

Each `mysql-query` tab SHALL render a result panel below the editor. The panel MUST:

- Render a hint state when no run has occurred yet in this tab. The hint MUST advertise both run and autocomplete shortcuts so the user discovers them on first use; the recommended copy is `Press ⌘↩ to run · Tab to autocomplete`.
- Render a virtualized read-only data grid (the `<MysqlAdhocResultGrid />` provided by `mysql-data-grid`) for `kind: "rows"` results, displaying the `columns` and `rows` from the response. The grid MUST support row selection that drives the shell's right inspector (when the inspector is expanded). Column widths inside the grid MUST default to the type-derived base widths defined by `column-width-preferences` and MUST be user-resizable; resizing MUST NOT persist to disk across runs or sessions, but MUST persist within the same `<MysqlAdhocResultGrid />` instance for as long as the columns prop shape is unchanged.
- Render a compact summary line for `kind: "affected"` results: `<command_tag> · <affected_rows> rows affected · <query_ms> ms`. Example: `INSERT · 3 rows affected · 12 ms`.
- Display the shared `<TruncationBanner />` above the grid whenever the response has `truncated: true`, per the `sql-result-row-cap` capability. The banner MUST name the response's `row_cap` rather than a hardcoded `10,000`, and its dialect clause is `LIMIT`.

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

- **WHEN** a run against a larger table comes back with `truncated: true`, `row_cap: 10000`, `row_cap_source: "setting"`
- **THEN** a banner reads `Showing the first 10,000 rows — the result hit Argus's row limit. Raise the limit or add a LIMIT clause.` above the grid

#### Scenario: Adhoc grid column widths reset when columns prop changes

- **WHEN** the user runs `` SELECT id, email FROM `app`.`users` ``, resizes `email` to 320px, then runs `` SELECT id, email, status FROM `app`.`users` `` in the same tab
- **THEN** the new result re-renders the grid with `id`, `email`, and `status` at their type-derived base widths
- **AND** the previous 320px override for `email` is discarded
