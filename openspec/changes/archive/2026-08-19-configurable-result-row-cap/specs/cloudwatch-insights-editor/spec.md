## ADDED Requirements

### Requirement: Insights run responses carry the effective row cap

`cloudwatch_run_insights` SHALL carry two additional fields on its rows-shaped payload, per the
`sql-result-row-cap` capability:

- `row_cap: number` — the effective cap applied to the query.
- `row_cap_source: "setting" | "hard_ceiling" | "engine"` — which constraint was binding.

For CloudWatch Logs Insights the engine ceiling is **10,000** — AWS returns at most 10,000 records
per query — so `row_cap` is `min(configured_cap, 10_000)` and `row_cap_source` is `"engine"`
whenever the configured cap exceeds 10,000, `"setting"` otherwise. The fields are additive;
`columns`, `rows`, `query_ms`, `truncated`, `records_matched`, `records_scanned`, `bytes_scanned`
are otherwise unchanged.

#### Scenario: Configured cap above the AWS ceiling is reported as engine-clamped

- **WHEN** `sql.rowCap` is `100000` and an Insights query is run
- **THEN** the response has `row_cap: 10000` and `row_cap_source: "engine"`

#### Scenario: Configured cap below the AWS ceiling governs

- **WHEN** `sql.rowCap` is `1000` and an Insights query matches more rows than that
- **THEN** the response has `row_cap: 1000`, `row_cap_source: "setting"`, and `truncated: true`

#### Scenario: Engine-clamped banner explains the AWS limit and offers no raise action

- **WHEN** a result comes back with `truncated: true`, `row_cap: 10000`, `row_cap_source: "engine"`
- **THEN** the banner reads `Showing the first 10,000 rows — CloudWatch Logs Insights returns at most 10,000 records per query.`
- **AND** no **Raise limit** action is offered

## MODIFIED Requirements

### Requirement: The query's own limit is honored

When the Insights query string contains a `limit` command (e.g. `| limit 100`), the run SHALL NOT
send a `StartQuery` `limit` parameter, so the query's own limit governs the number of returned
rows. When the query string contains no `limit` command, the run MAY apply a default limit, which
MUST never exceed the effective row cap.

The effective row cap for this engine is `min(configured_cap, 10_000)`, where `configured_cap`
comes from the `sql.rowCap` setting (default 10,000) per the `sql-result-row-cap` capability, and
10,000 is the AWS Logs Insights per-query record ceiling. Raising `sql.rowCap` above 10,000 MUST
NOT raise the number of Insights rows returned; the response reports this via
`row_cap_source: "engine"`. Both the server-side `limit` parameter and the client-side row
projection MUST clamp to the effective cap, and the client cap (with the `truncated` flag) remains
the hard upper bound in all cases.

The client-side projection loop MUST accumulate up to `effective_cap + 1` records before stopping,
projecting at most `effective_cap` of them and setting `truncated = (accumulated > effective_cap)`,
per `sql-result-row-cap`, "Exactly-at-cap results are not truncated" — so a result landing exactly
on the cap is reported complete. Accordingly, when the run does apply a server-side `limit`
parameter (i.e. the query string has no `limit` command), that parameter MUST be
`min(effective_cap + 1, 10_000)` rather than `effective_cap`, so the extra probe record is
available to distinguish "exactly the cap" from "more than the cap".

#### Scenario: Query limit is respected

- **WHEN** the user runs `fields @timestamp, @message | limit 100` over a log group with thousands of matching events
- **THEN** the result contains at most 100 rows (the query's limit), not the default

#### Scenario: Limitless query is still capped

- **WHEN** the user runs a query with no `limit` command that would match more rows than the effective row cap
- **THEN** the result is capped at the effective row cap and `truncated` is `true`

#### Scenario: Lowering the setting lowers the Insights cap

- **WHEN** `sql.rowCap` is `500` and the user runs a query with no `limit` command matching thousands of events
- **THEN** the server-side `limit` parameter is at most 500 and the result contains at most 500 rows with `truncated: true`

#### Scenario: Raising the setting above the AWS ceiling changes nothing

- **WHEN** `sql.rowCap` is `100000` and the user runs a query with no `limit` command matching more than 10,000 events
- **THEN** the result contains at most 10,000 rows with `truncated: true` and `row_cap: 10000`
