## 1. Postgres FilterBar — plain Enter applies with current combinator

- [x] 1.1 In `src/modules/postgres/data/filter-bar/FilterBar.tsx`, extend the existing root `onKeyDown` handler (around line 183–218) to handle plain `Enter` (no modifier) by calling `handleApplyAll()` without mutating `draft.combinator`.
- [x] 1.2 Add a defensive guard: if `document.activeElement` has `data-chip-input="true"` and a non-empty value, return early so `ChipInput` handles the keystroke.
- [x] 1.3 Keep the existing CodeMirror guard (`closest(".cm-editor")` early-return) ahead of the new branch so Raw-editor Enter is never intercepted.
- [x] 1.4 Verify the existing `⌘↩` (AND) and `⇧⌘↩` (OR) scenarios still pass.

## 2. Postgres ChipInput — stop Enter from bubbling

- [x] 2.1 In `src/modules/postgres/data/filter-bar/ValueInput.tsx`, in the `ChipInput` component's `onKeyDown`, after the existing `e.preventDefault()` on Enter, also call `e.stopPropagation()` so the bar-root handler never sees the keystroke when a chip commit is in progress.
- [x] 2.2 Add `data-chip-input="true"` to the `ChipInput` `<input>` element so the bar-root guard from task 1.2 can identify it.
- [x] 2.3 Verify that Enter still commits a chip (no behavioural regression for `In` / `NotIn` operators).
- [x] 2.4 Verify that Enter with an empty chip draft still falls through to Apply All (covered by the new Postgres scenario "Plain Enter in ChipInput with empty draft applies").

## 3. MySQL FilterBar — onKeyDown on value input

- [x] 3.1 In `src/modules/mysql/data/FilterBar.tsx` (around line 246–254), add `onKeyDown` to the value `<input>` that calls `onApply()` when `e.key === "Enter"` and no modifier keys are pressed. Call `e.preventDefault()`.
- [x] 3.2 Confirm `onApply` is in scope at the row level (it's already a prop per `FilterBar.tsx:56`).
- [x] 3.3 For BETWEEN's "min,max" single-input variant, the same handler works — no special-casing needed.

## 4. MSSQL FilterBar — onKeyDown on value input

- [x] 4.1 In `src/modules/mssql/data/FilterBar.tsx` (around line 243–251), add `onKeyDown` to the value `<input>` that calls `onApply()` when `e.key === "Enter"` and no modifier keys are pressed. Call `e.preventDefault()`.
- [x] 4.2 Confirm `onApply` is in scope at the row level (prop per `FilterBar.tsx:59`).

## 5. Dynamo QueryBuilder — onKeyDown on filter value editors

- [x] 5.1 In `src/modules/dynamo/data-view/QueryBuilder.tsx`, locate the filter-row value editor section (around line 204–252 per the design doc) and add `onKeyDown` to the text and number editors so plain Enter (no modifier) calls `handleRun()` and `e.preventDefault()`.
- [x] 5.2 Do NOT add a plain-Enter handler to the boolean toggle or to unary operators (`attribute_exists` / `attribute_not_exists`) that render no value editor.
- [x] 5.3 Do NOT add a plain-Enter handler to partition-key or sort-key inputs (the spec excludes them to avoid conflicting with tab-level `⌘R`).
- [x] 5.4 Confirm that `handleRun()` is a no-op when the builder is invalid (e.g. BETWEEN with an empty max) — no UX regression for partially-filled rows.

## 6. Verification

- [x] 6.1 Type a value in a MySQL filter row, press Enter → grid re-fetches with the new filter.
- [x] 6.2 Type a value in an MSSQL filter row, press Enter → grid re-fetches.
- [x] 6.3 In Postgres, set `filter_root_combinator` to `OR`, type a value, press Enter → grid re-fetches with OR combinator and the persisted preference is unchanged.
- [x] 6.4 In Postgres, with an `In` filter row, type a chip value and press Enter → chip is committed, grid does NOT re-fetch.
- [x] 6.5 In Postgres, with an `In` filter row and an empty chip draft, press Enter → grid re-fetches.
- [x] 6.6 In Postgres, ⌘↩ and ⇧⌘↩ still force AND / OR (regression check).
- [x] 6.7 In Dynamo Scan mode, add a `status = "ok"` filter, type the value, press Enter → `dynamo.scan` dispatches.
- [x] 6.8 In Dynamo, the Run button's dirty pip clears after Enter (parity with clicking Run).
- [x] 6.9 Run `npm run check` / `npm run lint` / `cargo check` (or whatever the project's pre-flight is) and resolve any issues.
- [ ] 6.10 Smoke-test column picker and operator picker dropdowns: Enter still selects the option, does NOT bubble to Apply All.

## 7. Wrap-up

- [x] 7.1 Update `CHANGELOG.md` with a one-line entry under the unreleased section: "Plain Enter now applies filters in the data grid across Postgres, MySQL, MSSQL, and Dynamo (fixes #53)."
- [ ] 7.2 Open a PR linking back to GitHub issue #53.
