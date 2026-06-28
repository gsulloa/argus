## 1. Keyboard handler — FilterBar.tsx

- [x] 1.1 In `onKeyDown` (no-meta region, before the `if (!meta) return;` guard), replace the existing plain-`Enter` branch with a combined no-meta Enter handler matching `e.key === "Enter" && !meta && !e.altKey`.
- [x] 1.2 Inside that handler, run the shared chip-input guard first: if the active element has `dataset.chipInput === "true"` and its `value !== ""`, `return` early (let the chip commit) — applies to both plain Enter and Shift+Enter.
- [x] 1.3 After the guard, call `e.preventDefault()`. If `e.shiftKey` is true → call `handleApplyAll()` and `return` (Apply All, current combinator).
- [x] 1.4 For plain Enter (no shift): resolve the focused row index from `document.activeElement.closest("[data-filter-row-index]")` (same pattern as `⌘I`/`⌘↑`). If `idx >= 0` call `onApplyOnlyRow(idx)`; otherwise fall back to `handleApplyAll()`. Then `return`.
- [x] 1.5 Add `onApplyOnlyRow` to the `onKeyDown` `useCallback` dependency array.
- [x] 1.6 Confirm the existing `⌘↵` (AND) and `⇧⌘↵` (OR) branches after the `if (!meta) return;` guard are untouched and still work.

## 2. Discoverability — footer hints & tooltip

- [x] 2.1 In the footer `FilterKeyHint` strip, add `Apply row: ↵` and `Apply All: ⇧↵` hint items (keep existing `Show ⌘F`, `Insert ⌘I`, `Remove ⌘⇧I`, `Up ⌘↑`, `Down ⌘↓`, `Columns ⌘←`); the prior `Apply All: ⌘↵` hint may be replaced by `⇧↵` since `⌘↵`/`⇧⌘↵` remain documented in the Apply All dropdown menu.
- [x] 2.2 (Optional polish) Update `RowApplyButton` tooltip copy to mention that `Enter` on the focused row does the same as clicking Apply.

## 3. Tests — FilterBar.test.tsx

- [x] 3.1 Add test: plain `Enter` with focus inside row index N calls `onApplyOnlyRow` with N (and does NOT call `onApplyAll`).
- [x] 3.2 Add test: plain `Enter` applies the focused row even when that row's checkbox is unchecked (still routes through `onApplyOnlyRow`, does not mutate `enabled`).
- [x] 3.3 Add test: `Shift+Enter` (no meta) calls `onApplyAll` and does NOT change `draft.combinator`.
- [x] 3.4 Add test: `Enter` in an `In`/`NotIn` chip input with non-empty draft text does NOT call `onApplyOnlyRow` nor `onApplyAll` (chip commit path preserved).
- [x] 3.5 Add/keep test: footer hint strip renders `Apply row: ↵` and `Apply All: ⇧↵`.
- [x] 3.6 Verify existing `⌘↵` / `⇧⌘↵` keyboard tests still pass unchanged.

## 4. Verification

- [x] 4.1 Run the filter-bar unit tests (`packages/app` vitest for `filter-bar`) and the type check; all green.
- [x] 4.2 Manual smoke per issue #198 repro: row A `id = 255` (checkbox on, applied), row B `email Contains e2e+` (checkbox off, focused) → pressing `Enter` in row B applies only `email Contains e2e+`; pressing `Shift+Enter` applies all enabled rows.
