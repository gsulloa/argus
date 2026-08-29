## 1. Pure projection helper

- [x] 1.1 In `packages/app/src/modules/postgres/data/filter-bar/treeMutations.ts`, add `applyOnlyRowModels(draft: FilterTree, index: number): { draft: FilterTree; applied: FilterTree } | null`. Return `null` when `draft.rows[index]` is missing or `!isCompleteRow(row)`. Otherwise build `enabledRow = row.enabled ? row : { ...row, enabled: true }` and return `{ draft: setEnabled(draft, index, true), applied: { rows: [enabledRow], combinator: draft.combinator } }`. Import `isCompleteRow` from `../types`. Document in a comment that `null` means "leave both models alone" so no caller can commit an `applied` that compiles to an empty payload.
- [x] 1.2 In `filter-bar/treeMutations.test.ts`, cover `applyOnlyRowModels`: (a) unchecked complete row → returned `draft.rows[index].enabled === true`, `applied.rows` is the single enabled row, other draft rows untouched; (b) already-enabled complete row → `applied.rows === [row]`, `draft` unchanged in content; (c) incomplete row (empty value) → `null`; (d) out-of-range index → `null`; (e) `applied.combinator === draft.combinator` and `draft.combinator` is never modified.
- [x] 1.3 Assert the round-trip in the same test file: `modelToPayload(applyOnlyRowModels(draft, i)!.applied)` returns an object with a `filter_tree` containing exactly one condition — this is the direct regression assertion for issue #289 (previously `{}`).

## 2. Wire the helper into the tab

- [x] 2.1 In `packages/app/src/modules/postgres/data/TableViewerTab.tsx`, rewrite `onApplyOnlyRow` (~line 669) to call `applyOnlyRowModels(draft, index)`; on `null` return without touching state; otherwise `setDraft(next.draft)`, `setApplied(next.applied)`, and bump `setApplyToken`. Update the `useCallback` deps to include `setDraft`.
- [x] 2.2 Replace the stale comment above `onApplyOnlyRow` with one stating the new contract: per-row Apply enables the target row so the committed `applied` always survives `modelToPayload`; incomplete rows are a no-op.
- [x] 2.3 Verify `onApplyFilters` (Apply All), `onUnsetFilters`, and `onResetFilters` are untouched, and that the new import from `./filter-bar/treeMutations` does not create a cycle.

## 3. Filter bar: completeness gate and feedback

- [x] 3.1 In `filter-bar/FilterBar.tsx`, add `handleApplyOnlyRow(i: number)` alongside `handleApplyAll`: if `draft.rows[i]` is missing or `!isCompleteRow(draft.rows[i])`, set the existing transient status to `"Row is incomplete"` (same `setTransientStatus` + 2s timer pattern as `"No filters enabled"`, clearing `transientTimerRef` first) and return; otherwise call `onApplyOnlyRow(i)`.
- [x] 3.2 Route both per-row entry points through it: the plain-`Enter` branch in `onKeyDown` (~line 277, `if (idx >= 0) onApplyOnlyRow(idx)`) and the row's Apply button (~line 459, `onApplyOnly={() => onApplyOnlyRow(i)}`). Add `handleApplyOnlyRow` to the `onKeyDown` `useCallback` deps in place of `onApplyOnlyRow`.
- [x] 3.3 Leave the `Shift+Enter`, `⌘↵`, `⇧⌘↵`, and Apply All paths exactly as they are.

## 4. Applied badge gating

- [x] 4.1 In `filter-bar/FilterBar.tsx`, change `buildAppliedSet` (~line 83) to skip any draft row where `!dr.enabled`, keeping the existing `isCompleteRow(dr)` gate and `filterRowEquals` match against `applied.rows`. Do not switch to `filterRowEqualsWithEnabled`.
- [x] 4.2 Update the `buildAppliedSet` doc comment: the badge means "this draft row's predicate, as currently configured, reached the query", so an unchecked row is never Applied; note the deliberate consequence that unchecking an applied row drops the badge while the dirty indicator takes over.

## 5. Update tests that encode the old contract

- [x] 5.1 `filter-bar/FilterBar.test.tsx` — "clicking calls onApplyOnlyRow with the row index" (~line 87) uses `modelWithRows(2)`, whose rows come from `makeEmptyRow()` and are **incomplete**, so the new gate would suppress the call. Change it to a two-row model of complete rows (e.g. `country Contains CL`) and keep asserting `onApplyOnlyRow` is called with `1`.
- [x] 5.2 Same file, test 3.1 "plain Enter with focus inside row 1 calls onApplyOnlyRow(1) and not onApplyAll" (~line 659) — same `modelWithRows` problem. Switch to complete rows; assertions unchanged.
- [x] 5.3 Same file, test 3.2 (~line 679) — rename to reflect that `FilterBar` delegates the enable-and-apply to `onApplyOnlyRow` and does not itself mutate `draft`. Keep `expect(onApplyOnlyRow).toHaveBeenCalledWith(1)` and `expect(onDraftChange).not.toHaveBeenCalled()`, and replace the "enabled flag must NOT have been changed by the Enter gesture" comment, which no longer describes the gesture as a whole.
- [x] 5.4 Same file, confirm 3.3 (`Shift+Enter`) and 3.4 (chip input) still pass unchanged; add a `modelWithCompleteRows(count)` helper if 5.1/5.2 would otherwise duplicate fixture code.

## 6. New regression tests

- [x] 6.1 `filter-bar/FilterBar.test.tsx` — plain `Enter` inside a **complete but unchecked** row calls `onApplyOnlyRow(index)` (the enable happens in the tab layer, verified by 1.2).
- [x] 6.2 Same file — the per-row Apply button and plain `Enter` on an **incomplete** row do NOT call `onApplyOnlyRow`, and the transient `"Row is incomplete"` status appears (use `waitFor`, mirroring the existing "No filters enabled" transient test).
- [x] 6.3 Same file — badge gating: with `applied.rows = [row]` and a structurally-equal but **unchecked** `draft.rows[0]`, the row's button reads `Apply` (not `Applied`) and the value input has no `--success` tint class; the checked equivalent still reads `Applied`.

## 7. Spec sync and verification

- [x] 7.1 Run `openspec validate filter-bar-per-row-apply-enabled --strict` and fix any reported issues.
- [x] 7.2 Run the app package tests (`pnpm --filter @argus/app test` or the repo's configured runner) plus typecheck/lint; confirm the full `filter-bar` and `postgres/data` suites are green.
- [ ] 7.3 Manual check against the issue #289 reproduction: apply `id = 255` (checked), add `email Contains e2e+` unchecked, focus its value input, press `Enter` → its checkbox turns on, the badge reads `Applied`, and the grid reflects the `email` predicate (not an unfiltered reload).
- [x] 7.4 Add a `CHANGELOG.md` entry under the unreleased section referencing issue #289.
