## ADDED Requirements

### Requirement: PartiQL run responses carry the effective row cap

`dynamo_run_partiql` and each `outcome: "ok"` step of `dynamo_run_partiql_many` SHALL carry two
additional fields on their rows-shaped payload, per the `sql-result-row-cap` capability:

- `row_cap: number` — the effective cap applied to that statement.
- `row_cap_source: "setting" | "hard_ceiling" | "engine"` — which constraint was binding.

Because DynamoDB PartiQL has **no `LIMIT` clause** (its limit is an `ExecuteStatement` request
parameter, not statement syntax), no statement-limit detection runs for this engine and
`row_cap_source` is always `"setting"`. The fields are additive; `items`, `count`, `query_ms`,
`truncated`, `consumed_capacity` and the `RunPartiQLResult` discriminants are otherwise unchanged.

#### Scenario: Run reports its cap from the setting

- **WHEN** `dynamo_run_partiql` returns a rows result with `sql.rowCap` at `50000`
- **THEN** the response includes `row_cap: 50000` and `row_cap_source: "setting"`

## MODIFIED Requirements

### Requirement: Result row cap and NextToken pagination

`dynamo_run_partiql` MUST page through `ExecuteStatement` using the opaque `NextToken` cursor,
accumulating items until the **effective cap** is reached, then stop and set `truncated: true`.
The effective cap is the configured cap from the `sql.rowCap` setting (default 10,000, clamped to
`[1, HARD_ROW_CAP]`) as defined by the `sql-result-row-cap` capability. DynamoDB PartiQL exposes
no statement-level `LIMIT`, so there is no per-statement override for this engine — the setting is
the only control.

Reaching the cap MUST stop pagination — no further `ExecuteStatement` call is issued once
`truncated` is set. The accumulated `ConsumedCapacity` MUST be aggregated across pages and
returned as `consumed_capacity` so the editor can display query cost.

Pagination MUST accumulate up to `effective_cap + 1` items before stopping, returning at most
`effective_cap` of them and setting `truncated = (accumulated > effective_cap)`, per
`sql-result-row-cap`, "Exactly-at-cap results are not truncated" — so a result landing exactly on
the cap is reported complete.

#### Scenario: Large result set is capped and flagged

- **WHEN** a SELECT returns more items than the effective cap across multiple `NextToken` pages
- **THEN** `items` contains exactly the cap and `truncated` is `true`
- **AND** no further `ExecuteStatement` page is requested

#### Scenario: Raising the setting raises the PartiQL cap

- **WHEN** the user sets `sql.rowCap` to `50000` and runs a SELECT matching more than 50,000 items
- **THEN** `items` contains 50,000 entries, `count` is `50000`, `truncated` is `true`, and `row_cap` is `50000`

#### Scenario: Truncation banner omits a clause suggestion

- **WHEN** a PartiQL result comes back with `truncated: true` and `row_cap_source: "setting"`
- **THEN** the banner names the cap and offers **Raise limit**, but does not suggest adding a `LIMIT` clause

#### Scenario: Consumed capacity reported

- **WHEN** any PartiQL statement completes successfully
- **THEN** `consumed_capacity` reflects the DynamoDB-reported total consumed capacity for that run, aggregated across pages
