## 1. Wire Unset to `applied` in the tab

- [x] 1.1 In `packages/app/src/modules/postgres/data/TableViewerTab.tsx`, add an `onUnsetFilters` callback next to `onApplyFilters` / `onApplyOnlyRow`: `setApplied({ rows: [], combinator: draft.combinator })` followed by `setApplyToken((t) => t + 1)`. Depend on `draft.combinator` and `setApplied` only — it must never read or write `draft` rows.
- [x] 1.2 Comment the handler to state that `draft` is deliberately untouched and that the token bump is required by the "Filter Apply always refetches" contract (D2).
- [x] 1.3 Pass `onUnsetFilters={onUnsetFilters}` to `<FilterBar>` in the same file.

## 2. Move Unset off the draft side of the filter bar

- [x] 2.1 In `filter-bar/FilterBar.tsx`, add `onUnsetFilters(): void` to `FilterBarProps` with a doc comment mirroring `onApplyAll`'s ("Unset — clears `applied` without touching `draft`").
- [x] 2.2 Replace `handleUnset`'s body with a direct call to `onUnsetFilters`; drop `unsetAllOperators` from the `./treeMutations` import list.
- [x] 2.3 Change the footer control's static prefix from `Operator:` to `Filters:` and its `title` to `Stop applying the filters — the filter form is kept as is`. Keep the button label `Unset`, keep `styles.unsetBtn`, and keep the control in its current footer slot (far right of `footerLeft`, non-adjacent to `Clear all`).
- [x] 2.4 Update the surrounding code comment (currently "Operator-scoped: keeps every row … and only drops the operator selection") to describe the new applied-scoped behaviour.

## 3. Remove the now-unused draft mutation

- [x] 3.1 Delete `unsetAllOperators` from `filter-bar/treeMutations.ts` (verify with a repo-wide grep that `FilterBar.tsx` was its only caller).
- [x] 3.2 Delete the `describe("unsetAllOperators", …)` block and its import in `filter-bar/treeMutations.test.ts`; keep the `clearAllRows` coverage untouched.

## 4. Retain the null-operator readers as documented legacy-compat

- [x] 4.1 Leave `FilterRow.op: Operator | null`, `isCompleteRow`'s null guard (`types.ts`), `OperatorPicker`'s `—` placeholder, `ValueInput`'s shape-derived control, `ConditionRow`'s `row.op === null` column-change branch, `compileWhere`'s `isCompleteRow` filter and `migrateLegacyFilterModel`'s null tolerance in place. Update each of their doc comments so they say the state is **only** reachable from records persisted by v0.8.6 and is no longer producible from the UI (D3).
- [x] 4.2 Confirm no remaining production code path can set `op` to `null`: grep for `op: null` and `op = null` outside tests and `migrateLegacyFilterModel.ts`.

## 5. Tests

- [x] 5.1 `filter-bar/FilterBar.test.tsx` — rewrite the three Unset cases: (a) clicking `Unset` calls `onUnsetFilters` exactly once and calls `onDraftChange` zero times; (b) after the click every row still renders its original column, operator and value, including a RAW row; (c) `Clear all` still calls `onDraftChange` and never `onUnsetFilters`. Update any query matching the `Operator:` prefix text.
- [x] 5.2 `TableViewerTab.test.tsx` — replace `Unset keeps the typed value and clears only the operator` and `Unset then Apply All unfilters the grid while keeping the rows` with: (a) `Unset` clears the applied filter and refetches with no `filter_tree` while the row's operator select still shows its original operator; (b) `Apply All` straight after `Unset` restores the identical `filter_tree` with no operator re-selection; (c) `Unset` with an already-empty `applied` still invokes `postgres.queryTable`.
- [x] 5.3 Add a `TableViewerTab.test.tsx` case asserting the bottom-bar `N filters` chip disappears after `Unset` while the filter bar still shows the rows.
- [x] 5.4 Add a `migrateLegacyFilterModel.test.ts` case (or confirm the existing one covers it) that a persisted record whose rows carry `op: null` rehydrates with those rows intact rather than resetting to `EMPTY_FILTER_MODEL`.
- [x] 5.5 Run `pnpm --filter @argus/app test` (or the repo's configured test command) and `pnpm --filter @argus/app typecheck`; both must pass.

## 6. Docs and changelog

- [x] 6.1 Add a `### Changed` bullet under `## [Unreleased]` in `CHANGELOG.md` in English, stating that the filter bar's `Unset` now stops applying the filters while leaving the filter form — operators included — exactly as built, superseding the v0.8.6 operator-clearing behaviour, and referencing [#278](https://github.com/gsulloa/argus/issues/278).
- [x] 6.2 Grep `README.md` and `docs/` for any description of `Operator: Unset` and update it to the new scope; skip if there is none.

## 7. Manual verification

- [ ] 7.1 Open a Postgres table, build a 3-row filter with different operators, `Apply All`, then click `Unset`: the grid must return to unfiltered, the three rows must be unchanged (operators still selected), the dirty pip must appear, the `Applied` badges must clear, and the bottom-bar filter chip must disappear.
- [ ] 7.2 Click `Apply All` immediately after: the previous filtering must return with no further edits.
- [ ] 7.3 Close and reopen the table after an `Unset`: the form must come back intact and still unapplied.
