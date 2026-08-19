## ADDED Requirements

### Requirement: Athena run responses carry the effective row cap

`athena_run_sql` and each `outcome: "ok"` step of `athena_run_sql_many` SHALL carry two additional
fields on their rows-shaped payload, per the `sql-result-row-cap` capability:

- `row_cap: number` — the effective cap applied to that statement.
- `row_cap_source: "setting" | "hard_ceiling" | "engine"` — which constraint was binding.

For Athena the engine ceiling is `HARD_ROW_CAP`, so `row_cap_source` is never `"engine"`. The
fields are additive; `columns`, `rows`, `query_ms`, `truncated`, `data_scanned_bytes` and the
`RunSqlResult` discriminants are otherwise unchanged.

#### Scenario: Single run reports its cap

- **WHEN** `athena_run_sql` returns a rows result with `sql.rowCap` at `10000` and no statement limit
- **THEN** the response includes `row_cap: 10000` and `row_cap_source: "setting"`

### Requirement: Athena export receives the truncation flag

The Athena result panel SHALL pass the result's `truncated` value to `<ExportMenu />`, so a
truncated export receives the `_truncated` filename suffix exactly as the other engines' exports
do. Rendering `<ExportMenu />` without the prop (letting it default to `false`) is not permitted.

#### Scenario: Truncated Athena export is marked

- **WHEN** the user exports a result whose response had `truncated: true`
- **THEN** the saved filename carries the `_truncated` suffix before its extension

## MODIFIED Requirements

### Requirement: Result row cap and pagination

`athena_run_sql` MUST page through `GetQueryResults` (which returns up to 1000 rows per page)
accumulating rows until the **effective cap** is reached, then stop and set `truncated: true`.
The effective cap is resolved per statement by the `sql-result-row-cap` capability —
`min(HARD_ROW_CAP, max(configured_cap, explicit_statement_limit))`, where `configured_cap` comes
from the `sql.rowCap` setting (default 10,000) and `explicit_statement_limit` is the
`Dialect::Presto` result of `explicit_row_limit` (trailing depth-0 `LIMIT <int>`; `LIMIT ALL`
yields no explicit limit).

Reaching the cap MUST stop pagination — no further `GetQueryResults` call is issued once
`truncated` is set. An explicit `LIMIT` MUST NOT be overridden downward: the effective cap is
never lower than the statement's own limit up to `HARD_ROW_CAP`.

Pagination MUST accumulate up to `effective_cap + 1` rows before stopping, returning at most
`effective_cap` of them and setting `truncated = (accumulated > effective_cap)`, per
`sql-result-row-cap`, "Exactly-at-cap results are not truncated" — so a result landing exactly on
the cap is reported complete.

The accumulated bytes-scanned figure MUST be read from
`GetQueryExecution.Statistics.DataScannedInBytes` and returned as `data_scanned_bytes` so the
editor can display query cost. Raising the cap does not change the bytes Athena scanned — only
the number of `GetQueryResults` pages fetched.

#### Scenario: Large result set is capped and flagged

- **WHEN** a query returns more rows than the effective cap
- **THEN** `rows` contains exactly the cap and `truncated` is `true`
- **AND** no further `GetQueryResults` page is requested

#### Scenario: Explicit LIMIT above the configured cap is honoured

- **WHEN** the user runs `SELECT * FROM events LIMIT 30000` with `sql.rowCap` at 10,000, against data with more than 30,000 matching rows
- **THEN** pagination continues to 30,000 rows and `truncated` is `false`

#### Scenario: LIMIT ALL does not raise the cap

- **WHEN** the user runs `SELECT * FROM events LIMIT ALL` with `sql.rowCap` at 10,000
- **THEN** the effective cap is 10,000 and the result is truncated at 10,000 rows

#### Scenario: Bytes scanned reported

- **WHEN** any query completes successfully
- **THEN** `data_scanned_bytes` reflects the Athena-reported scanned bytes for that execution
