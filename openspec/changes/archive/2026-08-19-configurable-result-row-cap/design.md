## Context

Argus caps every query result at a hardcoded `RESULT_ROW_CAP = 10_000`, declared six times —
once per engine, module-private, identical, with no override path:

| Engine | Constant | Applied at | Fetch shape |
| --- | --- | --- | --- |
| Postgres | `postgres/sql.rs:46` | `:721` (post-hoc `.take()`), `:830` (stream `break`) | `query()` materialises everything; `query_raw()` streams |
| MySQL | `mysql/sql.rs:39` | `:743` (post-hoc slice) | `fetch_all()` materialises everything |
| MSSQL | `mssql/sql.rs:39` | `:807` (post-hoc slice) | `into_first_result()` materialises everything |
| Athena | `athena/sql.rs:25` | `:385` inside `process_page_rows`, drives `while !truncated` at `:325` | `GetQueryResults`, 1000/page + `NextToken` |
| Dynamo | `dynamo/partiql.rs:183` | `:225` inside the item loop, `break` at `:236` | `ExecuteStatement` + `NextToken` |
| CloudWatch | `cloudwatch/insights.rs:27` | `:279` projection loop, **and** `:365` `.clamp(1, RESULT_ROW_CAP)` on the server-side `limit` param | single `GetQueryResults`, no pagination |

Constraints that shape the design:

- **No SQL parser.** `packages/app/src-tauri/Cargo.toml` has no `sqlparser`/`pg_query`; all SQL
  inspection is hand-rolled scanners (`split_statements` at `mysql/sql.rs:382` and
  `mssql/sql.rs:339`, `is_mutating_sql`, `has_limit_command` at `cloudwatch/insights.rs:152`).
- **A settings store already exists**: `settings(key TEXT PRIMARY KEY, value TEXT)`
  (`migrations/0001_init.sql:10-13`), Rust helpers `platform/settings.rs:7,18`, commands
  `settings_get`/`settings_set`, frontend `useSetting<T>(key, default)`
  (`platform/settings/useSetting.ts:15`). The numeric-defaulted-setting precedent is
  `read_history_retention` (`lib.rs:120-137`).
- **There is no Settings UI.** `platform/shell/tabs/settings-placeholder.tsx` renders
  "Settings UI ships in a follow-up change." Whatever surface this change adds must not depend
  on building one.
- **Result panels are fully duplicated** — six independent `ResultPanel.tsx`, five of them with
  byte-identical inline-styled banners using a hardcoded `rgba(245,158,11,0.1)` instead of
  `var(--warning)`. There is no shared result-panel chrome to extend; the shared component is new.
- **Zero test coverage on truncation UI**: `grep "Result truncated" --include="*.test.*"` returns
  nothing, and only Postgres has a `ResultPanel.test.tsx` at all.

## Goals / Non-Goals

**Goals:**

- An explicit row limit written in the statement is honoured, up to a hard ceiling.
- The default cap for unbounded queries is user-configurable and discoverable.
- Whatever cap was applied is reported back with the result and stated verbatim in the UI.
- `truncated` means exactly one thing on every engine: *the row cap stopped us*.
- Raising the cap does not turn a large result into an unbounded memory allocation.
- One shared implementation of cap resolution and of the truncation banner, not six.

**Non-Goals:**

- A full Settings tab. The toolbar control + banner action are the surfaces; the placeholder tab stays.
- Server-side paging / "load more" / cursor-based scrollback past the cap.
- Changing the table-browser page caps (`postgres/data.rs:29` `MAX_LIMIT = 5000`, MySQL/MSSQL 5000).
- A real SQL parser or grammar. Detection is deliberately partial.
- Per-tab cap override. The setting is global; a per-statement `LIMIT` is the per-run override.
- Streaming for MySQL/MSSQL/Athena/Dynamo/CloudWatch. Only Postgres gets the fetch rewrite.

## Decisions

### D1 — Effective cap is resolved per statement, backend-side

```
engine_ceiling  = HARD_ROW_CAP for pg/mysql/mssql/athena/dynamo
                = 10_000 for cloudwatch (AWS Logs Insights returns at most 10 000 records)

configured      = clamp(settings["sql.rowCap"] ?? 10_000, 1, HARD_ROW_CAP)
explicit        = explicit_row_limit(statement, dialect)        // Option<u64>

requested       = max(configured, explicit.unwrap_or(0))
effective_cap   = max(1, min(engine_ceiling, requested))

row_cap_source  = if effective_cap < requested:                 // something clamped us below what was asked for
                      Engine        if engine_ceiling < HARD_ROW_CAP
                      HardCeiling   otherwise
                  else if effective_cap >= HARD_ROW_CAP:         // sitting exactly on the hard ceiling
                      HardCeiling
                  else:
                      Setting
```

`HARD_ROW_CAP = 1_000_000`, `DEFAULT_ROW_CAP = 10_000`.

Two properties matter and are load-bearing:

- **An explicit limit only ever raises the cap, never lowers it.** `LIMIT 5` under a 10 000 cap
  resolves to 10 000; the database returns 5 rows anyway and `truncated` stays `false`. Lowering
  would be pointless work and would make `truncated` fire for results the engine already bounded.
- **An honoured explicit limit never truncates.** When `explicit ≤ effective_cap`, the engine
  itself returns ≤ `n` rows, so the `effective_cap + 1` probe fetch (see D8) never sees more than
  the cap and `truncated` stays `false` — not because "the engine bounded it", but because the
  probe row was never reached. Truncation with an explicit limit present therefore means one
  thing only: the statement asked for more than `HARD_ROW_CAP`, which reports
  `row_cap_source: "hard_ceiling"`.

*Alternative considered — resolve the cap in the frontend and pass `row_cap` as a command
argument.* Rejected: it puts the safety ceiling on the untrusted side, duplicates the resolution
rule across six `useQueryRun` hooks, and leaves non-UI callers (AI-generated runs, saved queries,
context queries) on the old hardcoded path. The backend already holds `DbState` at every command
entry (precedent: `mysql/sql.rs:1030`), so reading the setting there is cheap and central.

*Alternative considered — a per-tab override in tab state.* Rejected for v1: `sql.rowCap` is a
"how much of a haystack do I want in RAM" preference, not a per-query one, and the per-query
override already exists in the language (`LIMIT`).

### D2 — Conservative, dialect-aware limit detection; no parser crate

New `platform/sql_limit.rs`:

```rust
pub enum Dialect { Postgres, MySql, TSql, Presto }
pub fn explicit_row_limit(sql: &str, dialect: Dialect) -> Option<u64>
```

It reuses the scanning discipline already proven in `split_statements`: walk bytes tracking
`'…'` (with `\'` and `''`), `"…"`, `` `…` ``, `[…]` (T-SQL), `$tag$…$tag$` (Postgres),
`-- `/`#` line comments and `/* */` blocks, and parenthesis depth. Only **depth-0** tokens are
considered, so `WHERE id IN (SELECT id FROM t LIMIT 5)` is invisible to it.

Grammar recognised, all at depth 0:

| Dialect | Forms |
| --- | --- |
| Postgres | trailing `LIMIT <int>` (optionally followed by `OFFSET <int>`); `FETCH FIRST\|NEXT <int> ROW\|ROWS ONLY` |
| MySQL | trailing `LIMIT <int>`; `LIMIT <offset>, <count>` → returns `<count>` |
| Presto/Athena | trailing `LIMIT <int>` |
| T-SQL | leading `SELECT [ALL\|DISTINCT] TOP (<int>) [PERCENT]`/`TOP <int>`; trailing `OFFSET <int> ROWS FETCH NEXT <int> ROWS ONLY` |

Returns `None` — meaning "fall back to the configured cap" — for every one of:
`LIMIT ALL`, `LIMIT NULL`, `LIMIT $1`/`LIMIT ?`/`LIMIT @n`, `TOP <int> PERCENT`, a value that
does not parse as `u64`, a limit token that is not at depth 0, a statement whose first keyword
is not `SELECT`/`WITH`/`TABLE`/`VALUES`/`SHOW` (T-SQL: also `EXEC`… → `None`), or anything the
scanner cannot resolve unambiguously.

**False negatives are free** (status quo behaviour: the configured cap applies). **False
positives are the only real hazard** — they would raise the cap for a query the user did not
bound — hence "depth 0 + integer literal + recognised keyword position, or `None`".

*Alternative considered — add `sqlparser` (crate).* Rejected: a ~1 MB dependency and a full
`Statement` AST to answer a yes/no question, with its own dialect gaps (it does not cover
Athena/Presto or DynamoDB PartiQL well), on a codebase that has deliberately hand-rolled every
other SQL scan. Revisit if we ever need real semantic analysis.

*Alternative considered — a single regex like `has_limit_command`.* Rejected: `insights.rs:152`
gets away with `(?i)(^|\|)\s*limit\s+\d` because Insights query syntax is pipe-delimited and has
no string-quoting problem. SQL does — `SELECT 'limit 30000'` would false-positive.

### D3 — The cap travels back with the result: `row_cap` on every rows response

Every rows-shaped variant gains `row_cap: u64` (the effective cap for that statement), and the
Postgres `StreamEvent::Done` gains it too. This kills the hardcoded `"10,000"` string literal at
`postgres/sql/ResultPanel.tsx:202` and makes the banner correct by construction. Adding a field
to a `#[serde(tag = "kind")]` struct variant is additive on the wire; the TS types gain a
required field, which `tsc` will point at every construction site (tests included).

To let the banner explain *why* the cap was that number, the response also carries
`row_cap_source: "setting" | "hard_ceiling" | "engine"`:

- `"setting"` — the configured `sql.rowCap` is the binding constraint; raising it would raise the
  cap.
- `"hard_ceiling"` — `HARD_ROW_CAP` is the binding constraint, whether because a statement limit
  ran past it or because the user already set `sql.rowCap` to the maximum. Raising the setting
  cannot help. There is deliberately no `"statement"` variant: a statement limit the engine
  honours in full never truncates (D8), so "the statement's own limit stopped us" is a state the
  banner can never render — a statement limit large enough to matter is one that exceeded
  `HARD_ROW_CAP`, which is exactly `"hard_ceiling"`.
- `"engine"` — an engine ceiling below `HARD_ROW_CAP` clamped it (CloudWatch's 10,000-record
  limit, today).

*Alternative considered — have the frontend just re-read the setting for the banner text.*
Rejected: it is wrong whenever the statement carried a limit, and it races a setting the user
changed between run and render.

### D4 — Postgres `run_one` moves to `query_raw`

`postgres/sql.rs:713-722` currently comments that "`query` materializes the entire result set; we
cap by truncating after the fact… the cap [is] a safety net." That is already a lie about the
safety net, and at a 1 000 000-row cap it is a real hazard: the non-streaming path is what
`postgres_run_sql_many` uses for every statement in a multi-statement run. Rewriting `run_one` on
the same `query_raw` + `try_next()` loop as `run_one_stream` (`:794-833`) makes the cap an actual
early exit for both paths, and removes the last place where cap size and peak memory diverge.

MySQL (`fetch_all`), MSSQL (`into_first_result`) and CloudWatch (single response) keep
materialising — `sqlx`/`tiberius` streaming rewrites are a much larger change and those engines
have no streaming UI path today. This is called out as accepted debt in Risks, and is the reason
`HARD_ROW_CAP` exists.

### D5 — `truncated` means row cap, full stop

`mysql/sql.rs:756` and `mssql/sql.rs:821` currently return `truncated: result_truncated || any_truncated`,
folding the 1 MiB per-cell envelope (`INLINE_TRUNCATE_BYTES`) into the row-cap flag. Consequence
today: a three-row result with one oversized `TEXT` cell renders "Result truncated at 10,000 rows
— add a LIMIT clause to refine." and gets a `_truncated` export filename. Postgres already keeps
the two separate. MySQL and MSSQL are brought in line: `truncated` = row cap only,
`truncated_columns` = per-cell. `truncated_columns` was always in the response and is simply
un-shadowed; no field is added or removed.

This is behaviour-visible, so it is flagged **BREAKING** in the proposal even though nothing
persisted changes shape.

### D6 — Surfaces: a toolbar control, not a settings screen

`<RowCapSelector />` in the run toolbar of all six editors — a compact `Limit: 10k ▾` menu with
`1k / 10k / 50k / 100k / Custom…`, writing `sql.rowCap` through `useSetting<number>("sql.rowCap", 10000)`
(module-level memory cache + 150 ms debounced write, already handled by the hook). This is the
standard affordance in DataGrip/TablePlus, it sits where the user already looks when a result
disappoints them, and it needs no Settings tab.

`<TruncationBanner />` replaces all six inline banners. Copy, driven by `row_cap_source`:

| Condition | Copy |
| --- | --- |
| `setting` | `Showing the first 10,000 rows — the result hit Argus's row limit. Raise the limit or add a LIMIT clause.` |
| `hard_ceiling` | `Showing the first 1,000,000 rows — Argus's maximum result size. Narrow the query to see the rest.` |
| `engine`, CloudWatch | `Showing the first 10,000 rows — CloudWatch Logs Insights returns at most 10,000 records per query.` |

with an inline **Raise limit** button (absent for `hard_ceiling`/`engine`, where raising is not
possible) that opens the same menu as the toolbar control. Styling per `DESIGN.md`: `var(--warning)`
for the left rule and label — never the hardcoded `rgba(245,158,11,0.1)` copied into five files —
hairline border, compact density, no gradient. Clause wording stays per-dialect where it differs
(`LIMIT` vs `TOP`; Dynamo PartiQL has no clause to suggest, so its copy omits the sentence).

The Postgres in-flight streaming branch keeps passing `truncated={false}` (`ResultPanel.tsx:37`) —
correctly, since no cap information exists until the terminal event. Once `done` lands the run
transitions to `status: "done"` and renders through `ResultBody` with the real flag, so the
banner already appeared there before this change; what changes is that it now names the actual
`row_cap` instead of a hardcoded `10,000`.

### D7 — Per-engine application points

| Engine | Change |
| --- | --- |
| Postgres | `run_one` → `query_raw` loop with `if n >= cap { truncated = true; break }`; `run_one_stream` `:829-833` takes `cap` as a parameter |
| MySQL | `:742-757` slice against `cap`; `truncated` no longer ORs `any_truncated` |
| MSSQL | `:806-822` same; `TOP`/`FETCH NEXT` detection via `Dialect::TSql` |
| Athena | `process_page_rows` (`:361-369`) gains a `cap: usize` parameter; `while !truncated` at `:325` is unchanged and still stops pagination early. Also switch `.max_results(1000)` unchanged — the cap governs the loop, not the page size |
| Dynamo | `:225` `items.len() >= cap`; **no** statement-limit path — DynamoDB PartiQL has no `LIMIT` clause, its limit is an `ExecuteStatement` request parameter, so only the configured cap applies |
| CloudWatch | projection loop `:279` uses `min(configured, 10_000)`; `:362-366` keeps the existing `has_limit_command` branch (query's own `| limit` governs → send no `limit` param), otherwise `Some(limit.unwrap_or(1000).clamp(1, effective_cap))` |

### D8 — Fetch one row past the cap

**Problem.** A `break` at `count >= cap` cannot distinguish "there were exactly `cap` rows" from
"there were more than `cap` and we stopped early" — both look identical from inside the loop: the
`cap`-th row was fetched and the loop stopped. That ambiguity produces a false positive on the
one case this change exists to fix: `SELECT … LIMIT 30000` resolves to an effective cap of exactly
30,000, the engine returns exactly 30,000 rows, a `count >= cap` break fires on the 30,000th row,
and the response reports `truncated: true` — telling the user their complete, exactly-bounded
result had been cut short. The same ambiguity is why the pre-existing hardcoded 10,000 cap has
always reported `truncated: true` for a result that happens to contain exactly 10,000 rows.

**Fix.** Every engine fetches `fetch_budget(cap) = cap + 1` rows (or accumulates `cap + 1`
items/pages, for the pagination-based engines) instead of stopping at `cap`. The response returns
at most `cap` of them, and `truncated = (fetched > cap)`. Landing exactly on `cap` now yields
`fetched == cap`, so `truncated: false` — the ambiguity is gone because the loop always has one
extra data point past the boundary it cares about. `platform::row_cap::fetch_budget` is the single
shared helper; every engine's fetch/accumulate loop calls it instead of using `cap` directly as
its stopping bound.

This also retroactively corrects the pre-existing false positive: a query returning exactly 10,000
rows under the untouched default cap now correctly reports `truncated: false`, where it previously
always reported `truncated: true`.

*Alternative considered — request `cap` rows and separately ask "is there a `cap + 1`-th row?"
(e.g. a follow-up `COUNT(*)` or a second page fetch).* Rejected: it is a second round-trip (or a
second Athena/DynamoDB page) for information the engine already has in-flight; fetching one extra
row/item inline is strictly cheaper and requires no protocol beyond "keep pulling until `cap + 1`
or exhaustion".

## Risks / Trade-offs

- **[Memory: MySQL/MSSQL/CloudWatch still fully materialise before capping]** → `HARD_ROW_CAP = 1_000_000`
  is the backstop, and the `RowCapSelector` presets stop at 100k so reaching 1M requires typing a
  custom value. Postgres — the engine the report came from, and the only one with a streaming
  path — is fixed properly (D4). Streaming rewrites for `sqlx`/`tiberius` are accepted debt.
- **[False-positive limit detection raises a cap the user did not ask for]** → depth-0-only
  scanning, integer literals only, recognised keyword positions only, `None` on any ambiguity;
  and a unit-test corpus of adversarial statements (`SELECT 'limit 30000'`, `LIMIT` in a
  subquery/CTE/window frame, `LIMIT $1`, `-- LIMIT 99999`, `/* LIMIT 1 */`, `LIMIT ALL`,
  dollar-quoted bodies containing `LIMIT`, `TOP 50 PERCENT`) that must all resolve to `None`.
- **[Export of a very large result set]** → CSV/JSONL stream fine; XLSX at hundreds of thousands
  of rows is slow and memory-hungry. Known limitation, documented in the spec; no new guard in v1.
- **[Raising the cap raises real AWS cost on Athena/CloudWatch]** → Athena is billed on bytes
  scanned, which the cap does not change (the engine already scanned it); the extra cost is only
  `GetQueryResults` calls. CloudWatch cannot exceed 10 000 by construction. The bytes-scanned
  indicator already shown in both editors remains the cost signal.
- **[A user sets 1,000,000 and every unbounded `SELECT *` becomes slow]** → the setting is global
  and sticky, which is exactly the complaint the change is answering, but it can bite. The
  toolbar control shows the current value at all times, and `Custom…` validates into `[1, 1_000_000]`.
- **[D5 changes observable behaviour for MySQL/MSSQL users with oversized cells]** → strictly a
  correction: the banner and `_truncated` suffix stop firing on results that were never row-truncated.
  Per-cell truncation remains visible through `truncated_columns` and the cell's own `[truncated]`
  envelope rendering.
- **[Six engines × three layers is a wide diff]** → sequenced in `tasks.md` as shared primitives
  first, then Postgres end-to-end as the reference implementation (and the engine in the bug
  report), then the remaining five against that template.

## Migration Plan

No data migration. `sql.rowCap` is absent until the user changes it, and `configured_cap` falls
back to `DEFAULT_ROW_CAP = 10_000` — so an upgraded install behaves exactly as before for
unbounded queries, and differs only where the user wrote an explicit `LIMIT > 10_000`.
Rollback is a revert: the setting key is orphaned harmlessly in the `settings` table.

## Open Questions

- Should `sql.rowCap` be global (assumed here) or per-connection? Per-connection would fit a
  "prod is huge, local is small" workflow, but there is no per-connection settings surface today
  and `useSetting` is global-keyed. Deferred; a keyed variant (`sql.rowCap:<connectionId>`) is a
  compatible follow-up.
- `HARD_ROW_CAP = 1_000_000` is a judgement call. It is ~100× the current cap and comfortably
  above any plausible interactive use, but it is not derived from a measurement. Worth a
  memory-profile pass on a wide (50+ column) result before it ships.
