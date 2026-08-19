# sql-result-row-cap Specification

## Purpose
TBD - created by archiving change configurable-result-row-cap. Update Purpose after archive.
## Requirements
### Requirement: Result row cap setting

The app SHALL persist a global result row cap under the settings key `sql.rowCap` in the
existing `settings(key, value)` table, readable and writable through the existing
`settings_get` / `settings_set` commands and the frontend `useSetting` hook.

The default, applied whenever the key is absent, is `10000` — identical to the previously
hardcoded `RESULT_ROW_CAP`, so an install that never touches the setting behaves as before.

The backend MUST resolve the configured cap as
`clamp(parse_u64(settings["sql.rowCap"]).unwrap_or(DEFAULT_ROW_CAP), 1, HARD_ROW_CAP)`
where `DEFAULT_ROW_CAP = 10_000`. A missing, empty, non-numeric, zero, or out-of-range value
MUST NOT error — it MUST fall back to `DEFAULT_ROW_CAP` (non-numeric/missing) or be clamped
into range (numeric but out of bounds).

The setting MUST be read fresh at each run-command invocation, so a change takes effect on the
next run without an app restart and without invalidating any cache.

#### Scenario: Absent setting yields the default cap

- **WHEN** no `sql.rowCap` row exists in `settings` and a query is run
- **THEN** the configured cap is `10000`

#### Scenario: Setting governs the cap for an unbounded query

- **WHEN** `sql.rowCap` is `50000` and the user runs `SELECT * FROM big_table` (no limit clause) against a 1M-row table
- **THEN** the response contains 50,000 rows with `truncated: true` and `row_cap: 50000`

#### Scenario: Garbage setting value falls back to the default

- **WHEN** `sql.rowCap` holds `"abc"` (or `""`, or is `0`)
- **THEN** the configured cap resolves to `10000` and the run proceeds without error

#### Scenario: Setting change takes effect on the next run

- **WHEN** the user runs a query, changes `sql.rowCap` from `10000` to `25000`, and runs the same query again
- **THEN** the second run's response has `row_cap: 25000`

### Requirement: Non-configurable hard ceiling

The backend SHALL enforce a compile-time ceiling `HARD_ROW_CAP = 1_000_000` that no setting
value and no statement-level limit can exceed. Every effective cap MUST be `≤ HARD_ROW_CAP`.

#### Scenario: Setting above the ceiling is clamped

- **WHEN** `sql.rowCap` holds `5000000`
- **THEN** the configured cap resolves to `1000000`

#### Scenario: Statement limit above the ceiling is clamped and reported

- **WHEN** the user runs `SELECT * FROM huge LIMIT 5000000` against a table with more than 1M rows
- **THEN** the response contains 1,000,000 rows with `truncated: true`, `row_cap: 1000000`, and `row_cap_source: "hard_ceiling"`

#### Scenario: Setting at the ceiling reports the ceiling, not the setting

- **WHEN** `sql.rowCap` is `1000000` and a query truncates at that cap
- **THEN** `row_cap_source` is `"hard_ceiling"`, because raising the setting could not change the outcome

### Requirement: Per-statement effective cap resolution

For every statement executed by a run command, the backend SHALL resolve the effective cap as:

```
engine_ceiling = HARD_ROW_CAP                     // postgres, mysql, mssql, athena, dynamo
               = 10_000                           // cloudwatch (AWS Logs Insights limit)

configured     = the configured cap (see "Result row cap setting")
explicit       = explicit_row_limit(statement, dialect)   // Option<u64>, see below

effective_cap  = min(engine_ceiling, max(configured, explicit.unwrap_or(0)))
```

The cap is **per statement, not per run**: each step of a multi-statement run resolves its own
effective cap from its own statement text.

An explicit statement limit MUST only ever **raise** the effective cap above the configured
value; it MUST NOT lower it. `query_ms` MUST continue to measure end-to-end time including the
time spent fetching up to the effective cap.

#### Scenario: Explicit limit above the configured cap raises it

- **WHEN** `sql.rowCap` is `10000` and the user runs `SELECT * FROM events LIMIT 30000` against a table with more than 30,000 rows
- **THEN** the response contains 30,000 rows and `truncated: false` (the engine itself bounded the result)

#### Scenario: Explicit limit below the configured cap does not lower it

- **WHEN** `sql.rowCap` is `10000` and the user runs `SELECT * FROM events LIMIT 5`
- **THEN** the response contains 5 rows, `truncated: false`, and `row_cap: 10000`

#### Scenario: Each statement in a multi-statement run resolves its own cap

- **WHEN** the user runs `SELECT * FROM a; SELECT * FROM b LIMIT 40000;` with `sql.rowCap` at `10000`, both tables holding more than 40,000 rows
- **THEN** outcome 0 has 10,000 rows with `truncated: true` and `row_cap: 10000`
- **AND** outcome 1 has 40,000 rows with `truncated: false`

### Requirement: Conservative explicit-limit detection

The backend SHALL provide a shared helper `explicit_row_limit(sql, dialect) -> Option<u64>`
that reports a statement's own row limit without a full SQL parser. It MUST scan the statement
text while tracking string literals (`'…'` including `\'` and `''`), double-quoted identifiers,
backtick identifiers, T-SQL bracket identifiers, Postgres dollar-quoted bodies, `--` / `#` line
comments, `/* */` block comments, and parenthesis depth, and MUST only consider tokens at
parenthesis depth 0.

Recognised forms, by dialect:

| Dialect | Recognised |
|---|---|
| Postgres | trailing `LIMIT <int>` (with optional `OFFSET <int>`); `FETCH FIRST\|NEXT <int> ROW\|ROWS ONLY` |
| MySQL / MariaDB | trailing `LIMIT <int>`; `LIMIT <offset>, <count>` → `<count>` |
| Presto / Athena | trailing `LIMIT <int>` |
| T-SQL | leading `SELECT [ALL\|DISTINCT] TOP (<int>)` or `TOP <int>` (without `PERCENT`); trailing `OFFSET <int> ROWS FETCH NEXT <int> ROWS ONLY` → the `FETCH NEXT` value |

The helper MUST return `None` — meaning "no explicit limit, use the configured cap" — for every
case it cannot resolve unambiguously, including at minimum: `LIMIT ALL`, `LIMIT NULL`, a
placeholder or expression limit (`LIMIT $1`, `LIMIT ?`, `LIMIT @n`, `LIMIT 1+1`), `TOP <int> PERCENT`,
a value that does not parse as `u64`, a limit token at parenthesis depth > 0, a limit token
inside a string literal or comment, and a statement whose first significant keyword is not a
row-returning one (`SELECT`, `WITH`, `TABLE`, `VALUES`, `SHOW`).

False negatives are acceptable (the configured cap applies, i.e. today's behaviour). False
positives are not: when in doubt the helper MUST return `None`.

This capability MUST NOT introduce a SQL-parser crate dependency.

#### Scenario: Trailing LIMIT is detected

- **WHEN** `explicit_row_limit("SELECT * FROM t LIMIT 30000", Postgres)` is called
- **THEN** it returns `Some(30000)`

#### Scenario: LIMIT with OFFSET is detected

- **WHEN** `explicit_row_limit("SELECT * FROM t LIMIT 250 OFFSET 1000", Postgres)` is called
- **THEN** it returns `Some(250)`

#### Scenario: MySQL two-argument LIMIT returns the count

- **WHEN** `explicit_row_limit("SELECT * FROM t LIMIT 1000, 250", MySql)` is called
- **THEN** it returns `Some(250)`

#### Scenario: T-SQL TOP is detected

- **WHEN** `explicit_row_limit("SELECT TOP (25000) * FROM dbo.t", TSql)` is called
- **THEN** it returns `Some(25000)`

#### Scenario: T-SQL OFFSET/FETCH NEXT is detected

- **WHEN** `explicit_row_limit("SELECT * FROM dbo.t ORDER BY id OFFSET 0 ROWS FETCH NEXT 20000 ROWS ONLY", TSql)` is called
- **THEN** it returns `Some(20000)`

#### Scenario: LIMIT inside a string literal is ignored

- **WHEN** `explicit_row_limit("SELECT 'limit 30000' AS note FROM t", Postgres)` is called
- **THEN** it returns `None`

#### Scenario: LIMIT inside a comment is ignored

- **WHEN** `explicit_row_limit("SELECT * FROM t -- LIMIT 99999", Postgres)` or `explicit_row_limit("/* LIMIT 1 */ SELECT * FROM t", Postgres)` is called
- **THEN** it returns `None`

#### Scenario: LIMIT inside a subquery is ignored

- **WHEN** `explicit_row_limit("SELECT * FROM t WHERE id IN (SELECT id FROM u LIMIT 5)", Postgres)` is called
- **THEN** it returns `None`

#### Scenario: LIMIT inside a dollar-quoted body is ignored

- **WHEN** `explicit_row_limit("SELECT $$ LIMIT 42 $$ AS body", Postgres)` is called
- **THEN** it returns `None`

#### Scenario: Non-literal and non-numeric limits yield None

- **WHEN** `explicit_row_limit` is called with `LIMIT ALL`, `LIMIT $1`, `LIMIT ?`, or `SELECT TOP 50 PERCENT * FROM t`
- **THEN** it returns `None` in every case

### Requirement: Effective cap is reported with the result

Every rows-shaped run response across all engines SHALL carry:

- `row_cap: number` — the effective cap applied to that statement.
- `row_cap_source: "setting" | "hard_ceiling" | "engine"` — which constraint was binding, and
  therefore whether raising `sql.rowCap` could change the outcome:
  - `"setting"` — the configured cap is binding. Raising it helps.
  - `"hard_ceiling"` — `HARD_ROW_CAP` is binding, whether because a statement limit ran past it
    or because the user already set the maximum. Raising the setting cannot help.
  - `"engine"` — an engine ceiling below `HARD_ROW_CAP` is binding (CloudWatch's 10,000-record
    limit). Raising the setting cannot help.

There is deliberately **no `"statement"` source.** A statement limit the engine honours in full
never truncates (see "Exactly-at-cap results are not truncated"), so "the statement's own limit
stopped us" is not a state the banner can render. A statement limit large enough to truncate is
one that exceeded `HARD_ROW_CAP`, which reports `"hard_ceiling"`. That a statement limit raised
the cap remains observable: `row_cap` exceeds the configured setting.

For the Postgres streaming path these fields MUST also ride the terminal `done` event.

`row_cap` MUST be present regardless of `truncated`, so the UI can state the operative limit
even on a complete result.

#### Scenario: Untruncated result still reports the cap

- **WHEN** a SELECT returns 12 rows with `sql.rowCap` at `10000`
- **THEN** the response has `truncated: false`, `row_cap: 10000`, `row_cap_source: "setting"`

#### Scenario: Streaming done event carries the cap

- **WHEN** a Postgres streaming run reaches its `done` event after hitting the cap
- **THEN** the `done` event carries `truncated: true`, `row_cap`, and `row_cap_source`

### Requirement: Exactly-at-cap results are not truncated

Every engine SHALL fetch up to `effective_cap + 1` rows, return at most `effective_cap` of them,
and set `truncated = (rows_fetched > effective_cap)`. A result whose true cardinality is exactly
the effective cap MUST report `truncated: false`.

Without the extra probe row, a `break` at `count >= cap` cannot distinguish "there were exactly
`cap` rows" from "there were more"; a complete result would be reported as cut short. That
matters most for the case this capability exists to fix: `SELECT … LIMIT 30000` resolves to an
effective cap of exactly 30,000, and must come back as a complete result, not a truncated one.

This also corrects pre-existing behaviour — a query returning exactly 10,000 rows under the
default cap previously reported `truncated: true`.

#### Scenario: Result landing exactly on the cap is complete

- **WHEN** a SELECT matches exactly 10,000 rows and the effective cap is 10,000
- **THEN** the response has `rows.length === 10000` and `truncated: false`
- **AND** no truncation banner is rendered

#### Scenario: Honoured explicit limit is never reported as truncated

- **WHEN** the user runs `SELECT * FROM t LIMIT 30000` against a table with 1M rows, resolving to an effective cap of 30,000
- **THEN** the response has `rows.length === 30000` and `truncated: false`

#### Scenario: One row past the cap truncates

- **WHEN** a SELECT matches 10,001 rows and the effective cap is 10,000
- **THEN** the response has `rows.length === 10000` and `truncated: true`

### Requirement: `truncated` means the row cap was reached

Across all engines, `truncated: true` SHALL mean exactly one thing: the backend stopped
materializing rows because the effective cap was reached. It MUST NOT be set for any other
reason — in particular MUST NOT be set because one or more cell values exceeded the per-cell
`INLINE_TRUNCATE_BYTES` envelope. Per-cell truncation is reported separately and exclusively
through `truncated_columns` and the cell's own `{ kind: "truncated", … }` value envelope.

#### Scenario: Oversized cell does not set the row-cap flag

- **WHEN** a MySQL or MSSQL SELECT returns 3 rows, one of which holds a 2 MiB `TEXT` value
- **THEN** the response has `truncated: false` and `truncated_columns` naming that column
- **AND** no truncation banner is rendered
- **AND** an export of the result does not receive the `_truncated` filename suffix

#### Scenario: Row cap and oversized cell together

- **WHEN** a SELECT hits the effective cap and also contains an oversized cell
- **THEN** the response has `truncated: true` and `truncated_columns` naming that column

### Requirement: Shared truncation banner

The frontend SHALL provide one shared `<TruncationBanner />` component used by every engine's
result panel, replacing the per-engine inline-styled copies. It MUST render above the result
grid whenever the result has `truncated: true`, and MUST NOT render otherwise.

The banner MUST state the effective `row_cap` (thousands-separated) rather than a hardcoded
literal, and MUST explain the cap's origin using `row_cap_source`:

| `row_cap_source` | Copy |
|---|---|
| `setting` | `Showing the first <cap> rows — the result hit Argus's row limit. Raise the limit or add a <clause> clause.` |
| `hard_ceiling` | `Showing the first <cap> rows — Argus's maximum result size. Narrow the query to see the rest.` |
| `engine` | `Showing the first <cap> rows — <engine-specific reason>.` |

`<clause>` is dialect-specific: `LIMIT` for Postgres/MySQL/Athena, `TOP / OFFSET … FETCH NEXT`
for MSSQL; for DynamoDB PartiQL (which has no limit clause) the trailing sentence is omitted.

When `row_cap_source` is `"setting"`, the banner MUST offer an inline **Raise limit** action
that opens the same row-limit menu as the toolbar control. For `"hard_ceiling"` and `"engine"`
the action MUST be absent, because raising the setting cannot change the outcome.

The banner MUST follow `DESIGN.md`: `var(--warning)` for its rule and label (never a hardcoded
`rgba(…)`), hairline border, compact density, no gradient.

#### Scenario: Banner names the configured cap

- **WHEN** a result comes back with `truncated: true`, `row_cap: 50000`, `row_cap_source: "setting"` in the Postgres editor
- **THEN** the banner reads `Showing the first 50,000 rows — the result hit Argus's row limit. Raise the limit or add a LIMIT clause.`
- **AND** it offers a **Raise limit** action

#### Scenario: Hard-ceiling banner offers no raise action

- **WHEN** a result comes back with `truncated: true`, `row_cap: 1000000`, `row_cap_source: "hard_ceiling"`
- **THEN** the banner reads `Showing the first 1,000,000 rows — Argus's maximum result size. Narrow the query to see the rest.`
- **AND** no **Raise limit** action is offered

#### Scenario: No banner on a complete result

- **WHEN** a result comes back with `truncated: false`
- **THEN** no truncation banner is rendered, whatever `row_cap` says

### Requirement: Row-limit control in the editor toolbar

Every SQL/query editor toolbar (Postgres, MySQL, MSSQL, Athena, DynamoDB PartiQL, CloudWatch
Insights) SHALL render a shared `<RowCapSelector />` showing the current limit in abbreviated
form (e.g. `Limit: 10k`) and offering presets `1k`, `10k`, `50k`, `100k` plus `Custom…`.
Selecting a preset or entering a custom value writes `sql.rowCap` through `useSetting`.

`Custom…` MUST accept only integers in `[1, 1000000]` and MUST reject anything else without
writing the setting. The control MUST reflect the current value at all times, including after
the value is changed from another tab or from a banner's **Raise limit** action.

The control MUST NOT depend on a Settings tab existing; `settings-placeholder.tsx` remains a
placeholder under this change.

#### Scenario: Preset selection persists

- **WHEN** the user picks `50k` from the row-limit control
- **THEN** `sql.rowCap` is written as `50000` and the control reads `Limit: 50k`
- **AND** the next run of an unbounded query returns up to 50,000 rows

#### Scenario: Custom value out of range is rejected

- **WHEN** the user enters `0` or `2000000` in `Custom…`
- **THEN** the value is rejected, the setting is unchanged, and the control keeps its previous display

#### Scenario: Banner action and toolbar control stay in sync

- **WHEN** the user raises the limit to `100k` from a truncation banner's **Raise limit** action
- **THEN** the toolbar control in that tab reads `Limit: 100k`
- **AND** the control in another open query tab reflects `100k` as well

