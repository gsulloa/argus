## 1. Postgres — applyToken plumbing

- [x] 1.1 In `src/modules/postgres/data/useTableData.ts`, add an `applyToken?: number` field to `UseTableDataParams` (default `0`, document that callers MUST advance it on every user-initiated refresh gesture).
- [x] 1.2 Include `applyToken` in `depsKey` (around line 209) so a token bump always invalidates the captured cancellation identity.
- [x] 1.3 Add an inline comment above `depsKey` referencing `openspec/specs/postgres-data-grid` "Filter Apply always refetches" requirement.
- [x] 1.4 In `src/modules/postgres/data/TableViewerTab.tsx`, add `const [applyToken, setApplyToken] = useState(0)` near the other filter state.
- [x] 1.5 In `onApplyFilters` (around line 560), call `setApplyToken((t) => t + 1)` immediately after `setApplied(...)`.
- [x] 1.6 In `onApplyOnlyRow` (same block), do the same: `setApplyToken((t) => t + 1)` after `setApplied(...)`.
- [x] 1.7 Pass `applyToken` into the `useTableData(...)` call in this file.
- [x] 1.8 Verify the `⌘↵` / `⇧⌘↵` shortcuts route through `onApplyFilters` (they should — check the keyboard handler) so they get the token bump for free; otherwise bump the token where the shortcut fires.

## 2. Postgres — tests

- [x] 2.1 Add a Vitest unit test for `useTableData` (under `src/modules/postgres/data/__tests__/` or alongside existing tests) using `@testing-library/react`'s `renderHook` and a mocked IPC layer. Assertion: rendering with `applied = X, applyToken = 0`, then re-rendering with the same `applied = X, applyToken = 1`, results in two `postgres.queryTable` invocations.
- [ ] 2.2 Add a `TableViewerTab` integration-level test (or extend an existing one) that mounts the tab, simulates Apply All twice in a row with no filter changes, and asserts the IPC mock was called twice.
  <!-- skipped: No existing postgres TableViewerTab test suite to extend. The postgres tab has many dependencies (useTableFilter persists to disk, useTableOrderBy, useTablePrimaryKey, DataGrid, etc.) that would require a heavy mock scaffold not justified for this bug fix. The hook-level test in 2.1 already directly verifies the applyToken mechanism. A proper TableViewerTab integration test is a separate effort. -->

## 3. MySQL — harden refresh()

- [x] 3.1 In `src/modules/mysql/data/useTableData.ts`, add a comment above the `refresh` callback (line ~218) explaining that it MUST NOT depend on the `depsKey` guard — it directly resets and fetches; reference `openspec/specs/mysql-data-grid` "Filter Apply always refetches".
- [x] 3.2 Confirm `src/modules/mysql/data/TableViewerTab.tsx` (line ~547) keeps `onApply={tableData.refresh}` wiring; no behavioural change needed.

## 4. MySQL — tests

- [x] 4.1 Add a Vitest test for `useTableData.refresh()`: with `filterModel` unchanged, calling `refresh()` triggers a second `mysql.queryTable` IPC call (must fail before the contract is locked in if anyone later routes `refresh` through `depsKey`).

## 5. MSSQL — harden refresh()

- [x] 5.1 In `src/modules/mssql/data/useTableData.ts`, add the same contract-locking comment above `refresh` (line ~217), referencing `openspec/specs/mssql-data-grid`.
- [x] 5.2 Confirm `src/modules/mssql/data/TableViewerTab.tsx` (line ~638) keeps `onApply={tableData.refresh}`.

## 6. MSSQL — tests

- [x] 6.1 Add a Vitest test for MSSQL `useTableData.refresh()` mirroring the MySQL test in 4.1, asserting a second `mssql.queryTable` call.

## 7. Manual verification

- [ ] 7.1 Run `bun run dev` and connect to a Postgres instance. Apply a filter `n = 1`, externally INSERT a new row matching the filter, clear the value, re-enter `1`, click Apply All. Verify the new row appears.
- [ ] 7.2 Repeat 7.1 against MySQL.
- [ ] 7.3 Repeat 7.1 against MSSQL.
- [ ] 7.4 Verify the dirty-indicator behaviour is unchanged: typing into a row without Apply does NOT refetch (no IPC call in the network/console traces).
- [ ] 7.5 Verify per-row Apply on the same row twice triggers two fetches.

## 8. Quality gates

- [x] 8.1 Run the full Vitest suite (`bun run test`) — all green. 92 files passed, 1 skipped (pre-existing), 1126 tests passed.
- [x] 8.2 Run TypeScript type-check (`bun run typecheck` or whatever the project script is) — clean.
- [x] 8.3 Run the project linter — pre-existing warnings only (mysql/mssql useTableData.ts line 154 unused-disable, TableViewerTab.tsx line 552 missing dep); zero new errors or warnings in our files.
- [ ] 8.4 If a `health` or QA script exists, run it and confirm no regression.

## 9. PR + spec archive

- [ ] 9.1 Reference issue #54 in the PR description ("Closes #54").
- [ ] 9.2 Link to `openspec/changes/fix-reapply-same-filter-refetch/` in the PR description.
- [ ] 9.3 After merge, archive the change with `openspec` so the spec deltas fold into `openspec/specs/{postgres,mysql,mssql}-data-grid/spec.md`.
