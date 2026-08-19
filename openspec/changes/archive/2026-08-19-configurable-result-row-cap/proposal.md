## Why

Every SQL/query editor in Argus caps a result set at a hardcoded `RESULT_ROW_CAP = 10_000`
(`postgres/sql.rs:46`, `mysql/sql.rs:39`, `mssql/sql.rs:39`, `athena/sql.rs:25`,
`dynamo/partiql.rs:183`, `cloudwatch/insights.rs:27`). The cap is applied unconditionally,
so a user who deliberately writes `SELECT … LIMIT 30000` still gets 10 000 rows back
(issue #276). The statement is the most explicit possible expression of intent, and the
client silently overrides it — and there is no setting, per-tab override, or any other
escape hatch. The cap is also not honestly reported: MySQL and MSSQL OR the row-cap flag
together with the unrelated 1 MiB per-cell truncation flag, so a 3-row result with one big
`TEXT` column renders the banner "Result truncated at 10,000 rows". And the banner names a
hardcoded literal `10,000` (`postgres/sql/ResultPanel.tsx:202`) rather than the cap actually
applied, so it cannot stay truthful once the cap becomes configurable.

## What Changes

- **A statement's explicit row limit wins.** Before running a statement, the backend detects a
  confidently-parseable statement-level row limit (`LIMIT n`, MySQL `LIMIT off, n`,
  `FETCH FIRST/NEXT n ROWS ONLY`, T-SQL `TOP (n)`) and raises that statement's effective cap
  to `n`. Detection is conservative: anything nested, parenthesised, parameterised, or
  otherwise ambiguous yields "no explicit limit" and the configured cap applies unchanged.
- **The default cap becomes user-configurable.** A new setting `sql.rowCap` (default `10000`)
  governs unbounded queries, surfaced by a shared **row-limit control in every SQL/query
  editor toolbar** (`1k / 10k / 50k / 100k / Custom…`) and readable/writable through the
  existing `settings_get` / `settings_set` commands.
- **A non-configurable hard ceiling** of `1_000_000` rows backstops both paths, so neither a
  runaway `LIMIT 999999999` nor a mis-typed setting can exhaust memory.
- **The effective cap travels with the result.** Every rows-shaped response (and the Postgres
  streaming `done` event) gains `row_cap: number` — the cap actually applied to that
  statement — so the UI can state the real number instead of the hardcoded literal `10,000`
  in `postgres/sql/ResultPanel.tsx:202`. It also gains `row_cap_source: "setting" | "hard_ceiling" |
  "engine"`, stating which constraint was binding and therefore whether raising `sql.rowCap` would
  change the outcome: `"setting"` (the configured cap is binding, raising it helps), `"hard_ceiling"`
  (the 1,000,000 ceiling is binding, whether a statement limit ran past it or the user already set
  the maximum), or `"engine"` (an engine's own lower ceiling is binding, e.g. CloudWatch's 10,000).
- **A result landing exactly on the cap is reported complete, not truncated.** Every engine fetches
  one row past the effective cap and returns `truncated = (fetched > cap)`, so `SELECT … LIMIT 30000`
  under an effective cap of 30,000 comes back as a complete result — and, as a side effect, a query
  returning exactly 10,000 rows under the previously-hardcoded cap no longer reports a false
  `truncated: true`.
- **Truncation becomes unmistakable and honest.** One shared `<TruncationBanner />` replaces
  the six duplicated banners; its copy names the effective cap, says *why* the cap was that
  number (setting / hard ceiling / engine limit), and offers an inline "Raise limit" action.
- **BREAKING (internal contract only, no persisted data):** MySQL and MSSQL stop folding
  per-cell truncation into `truncated`. `truncated` now means *row cap reached* on every
  engine; per-cell truncation stays in `truncated_columns`, matching Postgres today.
- **Postgres `run_one` stops materialising the whole result set.** It moves to the same
  `query_raw` streaming fetch that `run_one_stream` already uses, so the cap actually stops
  pulling rows instead of trimming an already-fully-materialised `Vec` after the fact
  (`postgres/sql.rs:713-722`) — required before any cap above 10 000 is safe.
- **Engine-specific ceilings are documented, not silently applied.** DynamoDB PartiQL has no
  `LIMIT` clause, so it gets the configurable cap only. CloudWatch Logs Insights is capped at
  10 000 records by AWS, so its effective cap is `min(configured, 10_000)` and the banner says so.
- Fixes a found gap: `athena/sql/ResultPanel.tsx:207-213` renders `<ExportMenu />` without
  passing `truncated`, so truncated Athena exports never get the `_truncated` filename suffix.

**Non-goals:** a full Settings tab (`settings-placeholder.tsx` stays a placeholder — the
toolbar control and the banner action are the surfaces); paging/"load more" beyond the cap;
raising the data-grid `MAX_LIMIT` (5 000) used by table browsing; adding a SQL-parser crate.

## Capabilities

### New Capabilities
- `sql-result-row-cap`: the cross-engine contract for result truncation — the `sql.rowCap`
  setting, the hard ceiling, the per-statement effective-cap resolution rule, the conservative
  explicit-limit detector and its dialect grammar, the `row_cap` response field, and the
  shared truncation-banner behaviour every engine must conform to.

### Modified Capabilities
- `postgres-sql-editor`: "Result row cap" changes from a fixed 10 000 to the resolved effective
  cap; `postgres_run_sql` / `_many` / `_stream` responses gain `row_cap`; `run_one` becomes
  streaming; the result-panel banner text is parameterised against the response `row_cap`.
- `mysql-sql-editor`: same cap change; `truncated` no longer ORs per-cell truncation; response
  gains `row_cap`; banner text parameterised.
- `mssql-sql-editor`: same cap change; `truncated` no longer ORs per-cell truncation; `TOP (n)`
  and `OFFSET … FETCH NEXT n ROWS ONLY` are honoured; response gains `row_cap`.
- `athena-sql-editor`: pagination stops at the effective cap; `LIMIT n` honoured; response gains
  `row_cap`; `ExportMenu` receives `truncated`.
- `dynamo-partiql-editor`: cap becomes the configured value (no statement-limit path — PartiQL
  has no `LIMIT` clause); response gains `row_cap`.
- `cloudwatch-insights-editor`: effective cap is `min(configured, 10_000)` (AWS ceiling); the
  existing `| limit n` behaviour is restated against the new resolution rule; response gains `row_cap`.
- `activity-log`: the truncated-SELECT scenario reports the effective cap as the `rows` metric,
  not the literal 10 000.

## Impact

**Backend (Rust)** — `packages/app/src-tauri/src/`:
- New `platform/sql_limit.rs`: `Dialect` enum + `explicit_row_limit(sql, dialect) -> Option<u64>`,
  a comment/string/identifier-aware scanner modelled on the existing `split_statements`
  state machines (`mysql/sql.rs:382`, `mssql/sql.rs:339`) and `has_limit_command`
  (`cloudwatch/insights.rs:152`). No new crate dependency.
- New `platform/row_cap.rs`: `DEFAULT_ROW_CAP`, `HARD_ROW_CAP`, `SETTING_KEY`, `configured_cap(&Connection)`
  (following the `read_history_retention` precedent at `lib.rs:120-137`) and
  `effective_cap(configured, explicit, engine_ceiling)`.
- The six `RESULT_ROW_CAP` constants are deleted; each run command resolves the cap at entry
  from `DbState` and threads it into `run_one` / `run_one_stream` / `run_single_sql_inner` /
  `process_page_rows` / the PartiQL page loop / the Insights projection loop.
- `postgres/sql.rs` `run_one` rewritten on `query_raw`; `RunSqlResult::Rows` and
  `StreamEvent::Done` gain `row_cap`; likewise the MySQL/MSSQL/Athena/Dynamo/CloudWatch result enums.
- `athena/sql.rs:750-772` `result_row_cap_sets_truncated_flag` needs updating (const → parameter).

**Frontend (TS/React)** — `packages/app/src/`:
- New `platform/sql/useRowCap.ts` (`useSetting<number>("sql.rowCap", 10000)`),
  `platform/sql/RowCapSelector.tsx`, `platform/sql/TruncationBanner.tsx` (+ CSS module,
  per `DESIGN.md`).
- `row_cap` added to the six result types (`postgres/sql/api.ts:5-42`, `mysql/types.ts:325`,
  `mssql/types.ts:345`, `athena/types.ts:78`, `dynamo/sql/api.ts:17`, `cloudwatch/types.ts:81`).
- The six `ResultPanel.tsx` files swap their inline banner for `<TruncationBanner />`; the six
  toolbars gain `<RowCapSelector />`.

**Data:** no migration — `sql.rowCap` is a new key in the existing `settings(key, value)` table
(`migrations/0001_init.sql:10-13`). Absent key ⇒ 10 000, so behaviour is unchanged until the
user opts in or writes an explicit `LIMIT`.

**Risk:** larger result sets mean more memory and larger exports; the hard ceiling plus the
Postgres streaming rewrite bound it. Grids are already virtualized (`@tanstack/react-virtual`),
so render cost is flat; XLSX export of ~1M rows stays slow and is called out as a known limit.
