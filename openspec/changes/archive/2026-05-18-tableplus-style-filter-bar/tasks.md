## 1. Types and model migration

- [x] 1.1 Rewrite `src/modules/postgres/data/types.ts` `FilterTree` / `FilterNode` / `FilterModel` to the new flat shape (`FilterRow` with `enabled`, `FilterTree = { rows, combinator }`, drop `mode` / `raw` from `FilterModel`).
- [x] 1.2 Add `EMPTY_FILTER_ROW` (defaults: `enabled: true`, `column: { kind: "any_column" }`, `op: "Contains"`, `value: ""`) and update `EMPTY_FILTER_TREE` / `EMPTY_FILTER_MODEL` accordingly.
- [x] 1.3 Update `modelToPayload(model)` to filter by `enabled && isComplete(row)` and emit `{ filter_tree: { children: [...], combinator } }` on the wire (each child as `kind: "condition"`).
- [x] 1.4 Implement `isCompleteRow(row): boolean` helper covering all operators (including `IS NULL` / `IS NOT NULL` which require no value).
- [x] 1.5 Implement `filterRowEquals(a, b)` (structural equality ignoring `enabled`) for the per-row Applied detection.
- [x] 1.6 Update `filterModelEquals` / `filterTreeEquals` for the new shape (compare rows including `enabled`).
- [x] 1.7 Implement a `migrateLegacyFilterModel(raw: unknown): FilterModel` shim that detects legacy shapes (presence of `mode`, `tree`, or `or_group` children) and returns `EMPTY_FILTER_MODEL` with a `console.info` log. Run it at every persistence load site.
- [x] 1.8 Remove `trimLeadingWhere` from `types.ts` if no longer used by any frontend code path (Raw mode is gone). If still used by `compilePrefilledSelect`, keep it.
- [x] 1.9 Update `treeMutations.ts` to operate on flat rows: `addRow`, `removeRow`, `setRow`, `setEnabled`, `setCombinator`, `clearAllRows`. Delete `addOrChildCondition`, `addRootOrGroup`, `removeOrChild`, `setOrChild`. Keep `coerceValueForOperator`.
- [x] 1.10 Rewrite `treeMutations.test.ts` for the new mutation surface (delete OR-group test cases).

## 2. Compile and wire-shape

- [x] 2.1 Update `compileWhere.ts` to compile a flat `FilterTree`. Drop the `or_group` branch in the compiler. Root predicates joined by `combinator` with no outer parentheses; single-row case emits the predicate alone.
- [x] 2.2 Update `compileWhere.test.ts`: drop OR-group scenarios; add flat-AND, flat-OR, single-row, mixed-enabled scenarios.
- [x] 2.3 Verify `compilePrefilledSelect` (consumed by SQL footer button) still emits a valid SELECT using `applied`. Add a regression test.

## 3. Persistence: visibility and combinator

- [x] 3.1 Add `filter_bar_visible BOOLEAN DEFAULT 0` and `filter_root_combinator TEXT DEFAULT 'AND'` columns to the per-table viewer settings table (or whatever the existing settings store uses). Match the `column_width_preferences` / `page_size` patterns.
- [x] 3.2 Create `useFilterBarVisible(connectionId, schema, relation)` hook returning `[visible, setVisible]`, backed by the settings store. Default `false`. Writes synchronously.
- [x] 3.3 Create `useFilterRootCombinator(connectionId, schema, relation)` hook returning `[combinator, setCombinator]`. Default `"AND"`. Writes synchronously.
- [x] 3.4 Wire both hooks into `TableViewerTab.tsx` so the loaded values seed `draft.combinator` and the bar's `visible` state on mount.

## 4. Filter bar core component

- [x] 4.1 Rewrite `src/modules/postgres/data/filter-bar/FilterBar.tsx` against the new model and the new props (no `mode`, no `onReset`, no `onOpenInSqlEditor` — replaced by `onSqlClick`; new `visible`, `onClose`, `combinator`, `onCombinatorChange`).
- [x] 4.2 Rewrite `ConditionRow.tsx` to be a `FilterRow`-aware row: checkbox at left, column picker, operator picker, value input, `Apply` / `Applied` button, `−`, `+`. Add `isFocusTarget` plumbing for ⌘F / ⌘↑/↓ focus routing.
- [x] 4.3 Implement the Applied visual state on `ConditionRow`: green `Applied` label using `--success`, value input with `--success-soft` background tint when `appliedSet.has(rowIndex)` is true.
- [x] 4.4 Implement the per-row `+` button: insert new empty row below this row's index. Insert at end if called from a row-less context.
- [x] 4.5 Implement the per-row `−` button: remove this row. If this is the last row, clear it to defaults instead.
- [x] 4.6 Implement the per-row Apply button: call `onApplyOnlyRow(index)` (preserved from current `TableViewerTab` plumbing).
- [x] 4.7 Implement the per-row checkbox: call `onSetEnabled(index, value)`.
- [x] 4.8 Delete `OrGroup.tsx`, `RawWhereEditor.tsx`, `ConfirmDialog.tsx` from the filter-bar directory (their related imports go away).
- [x] 4.9 Update `src/modules/shared/filter-bar/`: keep `FilterBarShell`, `FilterBarBody`, `FilterBarActions`, `RowApplyButton`, `FilterKeyHint`, `PrimaryButton`, `SecondaryButton`, `EmptyBodyRow`. Delete `FilterSegmentedToggle` and its test. Note: `FilterConnector`, `FilterTypeBadge`, `FilterRowAddButton`, `RootCombinatorToggle` are kept (with deprecation comment) because `QueryBuilder.tsx` (DynamoDB) still uses them — migration deferred to a follow-up.

## 5. Filter bar footer

- [x] 5.1 Build the footer strip layout in `FilterBar.module.css`. One row, left-aligned (`Export` disabled, `SQL` enabled, shortcut hints, `Operator: [Unset]`), right-aligned (`Apply All ▾` composed button).
- [x] 5.2 Implement `Export` as a placeholder button: `disabled`, `aria-disabled="true"`, `title="Export coming soon"`.
- [x] 5.3 Wire `SQL` to call `onSqlClick` which delegates to the existing `onOpenInSqlEditor` handler in `TableViewerTab`.
- [x] 5.4 Render the shortcut hint strip using `FilterKeyHint` for each label.
- [x] 5.5 Implement `Unset` button: clears `draft.rows` to a single `EMPTY_FILTER_ROW`, preserves `draft.combinator`, does NOT touch `applied`.
- [x] 5.6 Implement the `Apply All` composed button: primary click area (label `Apply All`, plus `(OR)` suffix when `combinator === "OR"`) and a chevron `▾` that opens a Radix UI DropdownMenu (already used by `ExportMenu`).
- [x] 5.7 Implement menu items: `Apply All Checked Filters with AND – Default` (`⌘↵`) and `Apply All Checked Filters with OR` (`⇧⌘↵`). Active combinator shows `✓`. Activating an item updates `draft.combinator` and immediately performs Apply All.
- [x] 5.8 Add the "No filters enabled" inline status that appears for ~2 seconds when Apply All is invoked with no enabled-complete rows.

## 6. Keyboard shortcuts

- [x] 6.1 In `FilterBar.tsx`, implement an `onKeyDown` handler scoped to the bar root that handles `⌘I`, `⌘⇧I`, `⌘↑`, `⌘↓`, `⌘←`, `⌘↵`, `⇧⌘↵`. Each handler calls `preventDefault()`. Skip when target is inside a `.cm-editor`.
- [x] 6.2 Implement `⌘I` (insert below focused row) — read `data-filter-row-index` from the closest ancestor row of `document.activeElement`; insert at `index + 1` or at end. Focus the new row's column picker.
- [x] 6.3 Implement `⌘⇧I` (remove focused row or clear if last) — read `data-filter-row-index`; if only one row remains, replace it with `EMPTY_FILTER_ROW`; otherwise remove and focus the row above (or stay at top if first row removed).
- [x] 6.4 Implement `⌘↑` / `⌘↓` (move focus to same control on neighbor row) — identify the current logical control by class or `data-filter-control` attribute, find the same control on the target row, call `.focus()`. No wrap.
- [x] 6.5 Implement `⌘←` (open column picker on focused row) — find the row's column picker trigger and dispatch a click / open programmatically.
- [x] 6.6 Implement `⌘↵` and `⇧⌘↵` (Apply All with AND / OR) — update `draft.combinator` then call `onApplyAll`.
- [x] 6.7 Update `TableViewerTab.tsx`'s window-level `⌘F` handler: rewrite from "focus only" to the toggle state machine in D2 (hidden → show+focus; visible+unfocused → focus; visible+focused → hide). Use the `useFilterBarVisible` hook.

## 7. TableViewerTab integration

- [x] 7.1 Update `TableViewerTab.tsx` to read `visible` from `useFilterBarVisible` and to render `<FilterBar />` only when `visible === true`.
- [x] 7.2 Add a `Filter` icon button in the `SubtabHeader` row (right side) that toggles visibility. Show an "active" state when `visible === true`. Use the existing `Funnel` / `Filter` icon from `lucide-react`.
- [x] 7.3 Adapt the `onApplyFilters` callback to consume the new model (`Apply All`): build `applied` from `draft.rows.filter(r => r.enabled && isCompleteRow(r))` plus `draft.combinator`.
- [x] 7.4 Keep `onApplyOnlyRow` semantics; adapt to flat-row indices.
- [x] 7.5 Remove all references to `onReset` / `Reset` (button removed). Remove the `Esc` discard-draft handler from `FilterBar.tsx`. Keep any other tab-level `Esc` handlers untouched. BottomBar `onClearFilters` still wired via `onClearFiltersFromBottomBar` → `resetFilter()`.
- [x] 7.6 Verify `filterCount` (used by `BottomBar`) still reflects `applied.rows.length` and continues to drive the "clear filters" badge.
- [x] 7.7 Update `useTableFilter.ts` if it carries `mode`-aware paths — strip them.

## 8. DESIGN.md and CSS tokens

- [x] 8.1 Add `--success-soft: rgba(74,222,128,0.12)` to DESIGN.md's dark-mode and light-mode color tables; describe its use as the filter-row applied tint.
- [x] 8.2 Ensure the global CSS file declares the token alongside the existing `--accent-soft`.
- [x] 8.3 Update `design/preview.html` if it includes the filter bar in its rendered preview, so the new layout / Applied state is visible in the live preview.

## 9. Migration of persisted state

- [x] 9.1 Where `FilterModel` is loaded from any cache or settings (React Query cache, viewer settings, sessionStorage if any), pipe the raw value through `migrateLegacyFilterModel` before constructing component state. Implemented via `normalizePersistedFilter` rewrite in `useTableFilter.ts` using `migrateLegacyFilterModel` on each half, plus `useSetting<unknown>` to prevent premature casting.
- [x] 9.2 Add a `migrateLegacyFilterModel.test.ts` covering: (a) new-shape passthrough, (b) `{ mode: "raw", raw: "..." }` → empty, (c) tree with `or_group` child → empty, (d) totally invalid input → empty, (e) partial shape (missing `combinator`) → backfilled `AND`.

## 10. Tests rewrite

- [x] 10.1 Rewrite `src/modules/postgres/data/filter-bar/FilterBar.test.tsx` covering visibility toggle (⌘F state machine), per-row checkbox, per-row Apply / Applied state, Apply All with AND / OR, ⌘I / ⌘⇧I / ⌘↑ / ⌘↓ / ⌘← / ⌘↵ / ⇧⌘↵ shortcuts, Unset, footer SQL button delegating to onOpenInSqlEditor, Export disabled. Note: chevron dropdown menu tests (Radix UI portal) replaced with equivalent keyboard shortcut tests due to jsdom portal limitations.
- [x] 10.2 Delete `src/modules/shared/filter-bar/__tests__/FilterConnector.test.tsx`, `FilterSegmentedToggle.test.tsx`, `FilterTypeBadge.test.tsx`, `FilterRowAddButton.test.tsx`. Update the remaining `__tests__/` files for the new prop shape (Shell, Body, Actions, Header). All 38 shared tests pass.
- [x] 10.3 Rewrite `useTableFilter.test.tsx` for the new model surface. Tests new `{rows, combinator}` shape, migration of legacy shapes, persistence across unmount/remount, and key isolation.
- [x] 10.4 Add `filterRowEquals.test.ts` covering scalar / array / object value equality, column-ref equality, op equality, `enabled`-flag ignoring. 13 test cases.

## 11. QA pass

- [x] 11.1 Manual: open a fresh table → bar hidden, no vertical space taken. Press `⌘F` → bar shows + first row focused. Press `⌘F` again → bar hides.
- [x] 11.2 Manual: add three rows, leave one unchecked, click `Apply All` → only checked rows applied, green `Applied` badge on checked rows.
- [x] 11.3 Manual: edit value on an applied row → badge flips to gray `Apply`.
- [x] 11.4 Manual: open chevron menu, pick `Apply All Checked Filters with OR` → ✓ moves to OR item, filters re-apply with OR; reopen tab → OR preserved.
- [x] 11.5 Manual: per-row Apply on second row of three → that row goes green, other applied rows lose green; dirty indicator reflects mismatch.
- [x] 11.6 Manual: `⌘I` inserts row below focus; `⌘⇧I` removes focus row; `⌘⇧I` on last row clears it.
- [x] 11.7 Manual: `⌘↑` / `⌘↓` navigate focus; `⌘←` opens column picker.
- [x] 11.8 Manual: `Unset` resets draft rows to one empty row; combinator preserved; `applied` unchanged until `Apply All`.
- [x] 11.9 Manual: `SQL` footer button opens SQL editor with current `applied` prefilled.
- [x] 11.10 Manual: `Export` button is visibly disabled and does nothing.
- [x] 11.11 Manual: load a tab whose persisted filter had `mode: "raw"` or an `or_group` — bar opens empty, no crash, `console.info` migration message present.
- [x] 11.12 Manual: cross-platform — repeat the core shortcuts on macOS and Linux/Windows (`Ctrl` instead of `⌘`).

## 12. OpenSpec validation and cleanup

- [x] 12.1 Run `openspec validate tableplus-style-filter-bar --strict` and fix any issues.
- [ ] 12.2 Update `openspec/specs/postgres-data-grid/spec.md` only after the change is archived (do not edit during implementation — the delta drives the archive step).
- [x] 12.3 Run the full frontend test suite; ensure no unrelated tests fail.
- [x] 12.4 Manually verify the dev build (`pnpm tauri dev`) boots and the filter bar behaves end-to-end.
