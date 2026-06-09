## Context

The table browser supports click-to-sort because `useTableData()` re-issues the query with an `ORDER BY` derived from the table/schema context. SQL-editor results have no such context — they are an opaque, already-fetched `{ columns, rows }` payload — so the only viable sort is **client-side over the loaded rows**.

Today the four SQL result grids diverge:

- **MySQL** `src/modules/mysql/sql/ResultPanel.tsx` (~215–237) renders the full `DataGrid` (which already has header click-to-sort wiring) but passes `orderBy={[]}` and `onSortChange={() => {}}`, so headers do nothing.
- **MSSQL** `src/modules/mssql/sql/ResultPanel.tsx` (~211–234) is an identical fork with the same dead wiring.
- **Postgres** `src/modules/postgres/sql/ResultPanel.tsx` uses `AdhocResultGrid`, explicitly described in-code as "purely presentational … zero sort/filter/edit affordances".
- **Athena** `src/modules/athena/sql/ResultPanel.tsx` uses a hand-rolled `SimpleTable` (`<table>` with plain `<th>`s, no sort).

The shared `OrderBy` shape (`{ column: string; direction: "asc" | "desc" }`) exists per-engine, and Postgres has a `sortHelpers.ts` with a `cycleSort` cycling primitive used only by its data viewer.

## Goals / Non-Goals

**Goals:**
- A single, consistent click-to-sort interaction on SQL result headers across all four engines, matching the table browser's asc → desc → unsorted cycle and ↑/↓ indicators.
- Correct ordering for the real cell shapes: numbers sort numerically, dates chronologically, text lexically, with `null`/`undefined` grouped deterministically.
- Zero impact on read-only engines: sorting is visual only, never re-queries, never mutates the source result.

**Non-Goals:**
- Multi-column / shift-click sort (the DataGrid's `OrderBy[]` allows it, but v1 ships single-column to match user expectation and keep the indicator unambiguous).
- Server-side re-query of SQL results (impossible without table context — explicitly out of scope).
- Changing the table browser's existing server-side sort.
- Persisting sort state across runs, tabs, or sessions.

## Decisions

### Decision 1: Client-side sort, not re-query
Sort the in-memory rows. **Rationale:** an arbitrary SQL result (joins, expressions, CTEs) has no single relation to re-`ORDER BY`. **Alternative considered:** wrapping the user's SQL in `SELECT * FROM (<sql>) ORDER BY …` — rejected: breaks on non-SELECT result sets, multi-statement runs, dialect quirks, and incurs a round-trip + cost (Athena bytes scanned) on every header click.

### Decision 2: One shared, presentation-only sort utility
Add a single helper (e.g. `sortResultRows(rows, columns, orderBy)`) that all four grids call, plus a `cycleSort`-style header-click reducer reused from / generalized out of Postgres's `sortHelpers.ts`. **Rationale:** the issue's core requirement is *consistency across engines*; four copies of comparison logic would re-introduce the drift that caused this bug. **Alternative considered:** per-engine inline sort — rejected as the cause of the current divergence.

### Decision 3: Comparison is value-aware via the `Value` envelope
The comparator inspects the typed `Value` envelope (and falls back to the column's declared type) to choose numeric, temporal, or string comparison; it does not blindly `String()`-compare. `null`/`undefined`/absent cells always sort to one end (last in `asc`, consistently) regardless of direction so they never interleave. The sort MUST be **stable** so equal keys preserve the server's original row order. **Rationale:** mixed string-coerced comparison would order `10` before `9`; users expect type-correct ordering. **Alternative considered:** sort purely on the rendered display string — rejected for numeric/date columns.

### Decision 4: State lives in the result panel, keyed to the current result
Each `ResultPanel` holds `const [orderBy, setOrderBy] = useState<OrderBy[]>([])`. The sorted rows are derived (memoized) from the raw result + `orderBy`; the raw result is never mutated. When a new run replaces the result (or the columns prop shape changes), `orderBy` resets to unsorted — consistent with the existing "column widths reset when columns prop changes" behavior. **Rationale:** keeps sorting ephemeral and avoids stale sort columns referencing a prior result's schema.

### Decision 5: MySQL/MSSQL reuse the existing DataGrid sort UI
For MySQL/MSSQL the `DataGrid` already renders the header click handler and ↑/↓ indicators driven by `orderBy`/`onSortChange`. We simply supply real state and feed it pre-sorted rows. **Rationale:** least-change, reuses tested UI. For Postgres `AdhocResultGrid` and Athena `SimpleTable`, the header click + indicator markup must be added to match.

## Risks / Trade-offs

- **Only the loaded (possibly truncated) rows are sorted** → When a result is truncated at the row cap, sorting reorders the fetched subset only, not the full table. Mitigation: this is inherent to client-side sort and acceptable; the existing truncation banner already tells the user to add a `LIMIT`. No additional UI claim of "fully sorted" is made.
- **Large result sets (up to the 10k cap) re-sort on each header click** → Mitigation: memoize the sorted rows on `(result, orderBy)`; a single-pass stable sort of ≤10k rows is well within a frame budget for a click interaction.
- **Mixed-type columns (NULLs, heterogeneous unions)** → Mitigation: deterministic null grouping + type-aware comparator with a defined fallback ordering when types are genuinely mixed; covered by spec scenarios.
- **Two DataGrid forks (MySQL/MSSQL) plus two bespoke grids drift again** → Mitigation: all four route through the one shared comparator/util; only the header-markup wiring differs per grid.

## Migration Plan

Pure additive frontend change; no data migration, no backend, no API change. Ships behind no flag — the new affordance simply appears. Rollback is reverting the frontend diff; existing results render exactly as before minus the sort interaction.

## Open Questions

- None blocking. Multi-column shift-click sort is deferred to a follow-up if requested.
