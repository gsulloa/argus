## 1. Shared sort utility

- [x] 1.1 Add a presentation-only sort helper `sortResultRows(rows, columns, orderBy)` that returns a new, stably-sorted array without mutating the input.
- [x] 1.2 Implement a value-aware comparator over the `Value` envelope (with column declared-type fallback): numeric → numeric compare, date/timestamp → chronological, text → lexical, plus a deterministic fallback for genuinely mixed types.
- [x] 1.3 Group `null`/`undefined`/absent cells deterministically at one end for both asc and desc (never interleaved with present values).
- [x] 1.4 Add/reuse a `cycleSort`-style header-click reducer (asc → desc → unsorted; clicking a different column → that column asc) generalized from `postgres/data/sortHelpers.ts`.
- [x] 1.5 Unit-test the comparator and cycle: numeric vs lexical, null grouping (asc & desc), stability on equal keys, three-state cycle, column switch.

## 2. MySQL SQL result panel

- [x] 2.1 In `src/modules/mysql/sql/ResultPanel.tsx`, add `const [orderBy, setOrderBy] = useState<OrderBy[]>([])`.
- [x] 2.2 Derive memoized sorted rows from `unifiedRows` + `orderBy` via the shared helper; pass them to the DataGrid.
- [x] 2.3 Replace `orderBy={[]}` and `onSortChange={() => {}}` with the real state and the cycle reducer.
- [x] 2.4 Reset `orderBy` to `[]` when the result / columns prop shape changes.

## 3. MSSQL SQL result panel

- [x] 3.1 Apply the same wiring as MySQL in `src/modules/mssql/sql/ResultPanel.tsx` (~211–234): local `orderBy` state, memoized sorted rows, real `onSortChange`, reset on new result.

## 4. Postgres SQL result panel

- [x] 4.1 Add header click-to-sort and ↑/↓ indicators to `src/modules/postgres/data/AdhocResultGrid.tsx`, driven by an `orderBy` prop + `onSortChange` callback (keeping it otherwise presentational).
- [x] 4.2 In `src/modules/postgres/sql/ResultPanel.tsx`, hold `orderBy` state, feed the grid sorted rows via the shared helper, wire the cycle reducer, and reset on new result.

## 5. Athena SQL result panel

- [x] 5.1 In `src/modules/athena/sql/ResultPanel.tsx` (`SimpleTable`, ~226–314), add `onClick` to each `<th>` and ↑/↓ indicators.
- [x] 5.2 Hold `orderBy` state in the panel, sort rows client-side via the shared helper, wire the cycle reducer, and reset on new result. Confirm no re-query / `StartQueryExecution` is triggered.

## 6. Verification

- [x] 6.1 Manually verify in each engine's SQL editor: click a header → asc → desc → unsorted, indicator matches, rows reorder, original order restored on clear. (Manual QA confirmed.)
- [x] 6.2 Verify numeric, date, text, and null-containing columns sort correctly and stably across all four engines. (Shared comparator used by all four engines; covered by `sortResultRows.test.ts` — 18 passing cases incl. numeric-vs-lexical, ISO dates, null grouping asc & desc, stability.)
- [x] 6.3 Confirm acceptance criteria from issue #91: sort after running SQL, visual direction indicator, consistent across all engines incl. read-only Athena. (Manual QA confirmed.)
- [x] 6.4 Run lint/typecheck and the frontend test suite. (typecheck clean; eslint clean on touched files; full suite green except two pre-existing failures on base: `Sidebar.dnd.test.tsx`, flaky `CacheProvider.test.tsx`.)
