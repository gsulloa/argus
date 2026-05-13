## 1. Data model & wire format (Postgres)

- [x] 1.1 In `src/modules/postgres/data/types.ts`, add `combinator?: "AND" | "OR"` to `FilterTree`. Update `EMPTY_FILTER_TREE` to include `combinator: "AND"`.
- [x] 1.2 Add a `getRootCombinator(tree: FilterTree): "AND" | "OR"` helper that returns `tree.combinator ?? "AND"`. Export it from the same module.
- [x] 1.3 Update `filterTreeEquals` to compare `combinator` (treating `undefined` as `"AND"` for backward-compat).
- [x] 1.4 In `src/modules/postgres/data/filter-bar/treeMutations.ts`, add `setRootCombinator(tree, combinator): FilterTree`. Ensure every existing mutation (`addRootCondition`, `addRootOrGroup`, `removeRootChild`, etc.) preserves the existing `combinator` field on the returned tree.
- [x] 1.5 Extend `treeMutations.test.ts` with cases: setRootCombinator round-trips; existing mutations preserve combinator; missing combinator coerces to AND through `getRootCombinator`.
- [x] 1.6 In the Rust backend (locate the `FilterTree` struct — likely `src-tauri/src/modules/postgres/data/filter.rs` or sibling), add `RootCombinator { And, Or }` enum with `Default::default() == And`. Add `#[serde(default)] combinator: RootCombinator` to `FilterTree`.
- [x] 1.7 In the SQL compiler, join root children with `" AND "` or `" OR "` based on `combinator`. Keep OR-group children always parenthesized.
- [x] 1.8 Extend Rust unit tests: OR-root with two simple children; OR-root with one condition + one OR-group; missing `combinator` field defaults to AND; AND-root regression unchanged.

## 2. Compile path (Postgres frontend)

- [x] 2.1 In `src/modules/postgres/data/filter-bar/compileWhere.ts`, join root children with `getRootCombinator(tree)` instead of the hard-coded `" AND "`.
- [x] 2.2 Verify `compilePrefilledSelect` (the Open-in-SQL-Editor path) honors the combinator and emits the user-readable SQL with the chosen connector.
- [x] 2.3 Extend `compileWhere.test.ts` with: OR-root flat children; OR-root + OR-group; empty tree still emits no WHERE; AND-root regression unchanged.

## 3. Persistence (Postgres)

- [x] 3.1 In `src/modules/postgres/data/useTableFilter.ts`, when reading a persisted `FilterModel`, coerce `draft.tree.combinator` and `applied.tree.combinator` to `"AND"` if absent (treat the missing field as the AND default).
- [x] 3.2 When writing, always serialize `combinator` (never omit). No migration sweep — natural on-write upgrade.
- [x] 3.3 Add a unit test that loading a record without `combinator` yields `"AND"` on both trees.

## 4. Shared primitives

- [x] 4.1 In `src/modules/shared/filter-bar/`, add a new `RootCombinatorToggle.tsx` component: segmented `AND | OR` control, controlled prop `value`, callback `onChange`, accessible (role="radiogroup" or role="tablist", clear aria-labels), respects `prefers-reduced-motion`. Colocate `RootCombinatorToggle.module.css`.
- [x] 4.2 Add a `RowApplyButton.tsx` primitive: small `▶` icon button with required `aria-label` prop and tooltip text. Style matches `RowRemoveButton` (right-edge alignment, 11px icon, hairline border, hover/focus halo per visual system).
- [x] 4.3 Add a `FilterBarHandle` interface in `src/modules/shared/filter-bar/index.ts` with a single `focus()` method. Export it.
- [x] 4.4 Add the convention `data-filter-focus-target="true"` to be set on whichever DOM node is the first interactive control. Document in the primitive layer's README/index header comment.
- [x] 4.5 Re-export `RootCombinatorToggle`, `RowApplyButton`, and `FilterBarHandle` from `src/modules/shared/filter-bar/index.ts`. Add snapshot tests for the two new primitives.

## 5. Postgres FilterBar wiring

- [x] 5.1 In `FilterBar.tsx`, convert the component to `forwardRef<FilterBarHandle, FilterBarProps>`. Implement `useImperativeHandle` exposing `focus()`.
- [x] 5.2 Implement the `focus()` resolver: if `collapsed` → `setCollapsed(false)` then on next tick focus the body's first `data-filter-focus-target="true"` element; if Raw mode → focus the Raw editor; if Structured + has rows → focus first row's column picker; if Structured + empty → focus the `+ AND row` add button.
- [x] 5.3 Render the `RootCombinatorToggle` inside `StructuredBody` adjacent to the `+ AND row` / `+ OR group` add buttons. Hide it when `tree.children.length === 0`. Wire `value={getRootCombinator(tree)}` and `onChange={c => updateTree(setRootCombinator(tree, c))}`.
- [x] 5.4 Update the inter-row connector pills (`FilterConnector`) to read the active combinator (`getRootCombinator(tree)`) instead of always `"AND"`.
- [x] 5.5 Add a new prop `onApplyOnlyRow(index: number)` to `FilterBarProps`. Render a `RowApplyButton` inside each `ConditionRow` (root scope) and inside the `OrGroup` header (group scope) wired to `onApplyOnlyRow(rootIndex)`.
- [x] 5.6 Set `data-filter-focus-target="true"` on the first column-picker in the body and on the `+ AND row` empty-state button.
- [x] 5.7 Extend `FilterBar.test.tsx`: combinator toggle renders/hides correctly, toggle flips connectors, per-row Apply fires `onApplyOnlyRow(index)`, `focus()` imperative API targets the correct element.

## 6. Postgres TableViewerTab wiring

- [x] 6.1 In `TableViewerTab.tsx`, hold a `filterBarRef: useRef<FilterBarHandle>(null)` and pass it to `<FilterBar ref={filterBarRef} … />`.
- [x] 6.2 Extend the existing active-tab `keydown` listener (the one handling `⌘S`, `⌘1`/`⌘2`/`⌘3`, `⌘Z`) with a `⌘F` / `Ctrl+F` branch: if active subtab is `data` AND focus is NOT inside `.cm-editor`, call `e.preventDefault()` then `filterBarRef.current?.focus()`. Add a regression test for the CodeMirror bail-out.
- [x] 6.3 Implement `onApplyOnlyRow` callback: build a `FilterModel` whose `tree.children` is `[draft.tree.children[index]]` (preserving `combinator`), then `setApplied(single)`.
- [x] 6.4 Pass `onApplyOnlyRow` to `<FilterBar … />`.
- [x] 6.5 Manual QA: cycle `⌘F` from grid focus, from inspector focus, from CodeMirror focus inside the Raw editor, from another tab focus, on Structure/Raw subtabs.

## 7. Dynamo data model & compile

- [x] 7.1 In `src/modules/dynamo/data-view/types.ts` (or wherever `BuilderState` lives), add `filterCombinator?: "AND" | "OR"`. Add a helper `getFilterCombinator(state): "AND" | "OR"` returning `state.filterCombinator ?? "AND"`.
- [x] 7.2 In `src/modules/dynamo/data-view/builderCompiler.ts`, join filter rows with `" AND "` or `" OR "` based on the combinator. Keep value/name placeholder allocation logic unchanged.
- [x] 7.3 Update `normalizeForDirty` in `QueryBuilder.tsx` to include `filterCombinator` in the JSON snapshot.
- [x] 7.4 Extend `builderCompiler` unit tests with AND-of-two, OR-of-two, single-row both ways, empty-filters both ways (no expression emitted).

## 8. Dynamo QueryBuilder wiring

- [x] 8.1 Convert `QueryBuilder` to `forwardRef<FilterBarHandle, QueryBuilderProps>`. Implement `useImperativeHandle` exposing `focus()` using the resolver from section 5.2 adapted to Dynamo's body (Query-mode-with-empty-PK → PK input; filters exist → first filter row's attribute input; empty → `+ Filter` button).
- [x] 8.2 Render `RootCombinatorToggle` adjacent to the `+ Filter` add button in the filters section. Hide it when `filters.length === 0`.
- [x] 8.3 Wire `value={getFilterCombinator(builder)}` and `onChange={c => { onBuilderChange({ ...builder, filterCombinator: c }); revalidate(...); }}`.
- [x] 8.4 Update the inter-row `FilterConnector` between filter rows to display the active combinator.
- [x] 8.5 Add `onApplyOnlyFilter?: (transient: BuilderState) => void` to `QueryBuilderProps` (Option B: host receives transient state, QueryBuilder marks lastRunStateRef). Render a `RowApplyButton` inside `FilterRowEditor`.
- [x] 8.6 Set `data-filter-focus-target` markers on the appropriate elements (PK input, first filter attribute input, add button queried by testid).
- [x] 8.7 Extend QueryBuilder tests: combinator OR compile path, hidden toggle when empty, per-row Apply callback fires with the right index, forwardRef focus() targets correct element.

## 9. Dynamo DataViewTab wiring

- [x] 9.1 In the Dynamo data-view tab root (`DataViewTab.tsx`), hold a ref to the `QueryBuilder` handle and install a `⌘F` keydown listener with the same active-tab + skip-CodeMirror discipline as Postgres.
- [x] 9.2 Implement `onApplyOnlyFilter(transient)`: receives transient `BuilderState` from `QueryBuilder` and dispatches via `useDynamoItems.runWithOverride(transient)` (new method added to hook). QueryBuilder marks `lastRunStateRef` to the transient state internally so the dirty pip reflects divergence from the user's full draft.
- [x] 9.3 Pass `onApplyOnlyFilter` and `ref={queryBuilderRef}` to `<QueryBuilder … />`.
- [x] 9.4 Manual QA: per-row Apply in Scan mode and Query mode; combinator toggle in both modes; `⌘F` cycle from various focus points.

## 10. Visual system & DESIGN.md

- [x] 10.1 Add the segmented-toggle treatment used by `RootCombinatorToggle` to `DESIGN.md`'s decisions log under a 2026-05-14 entry. Reference the existing Structured/Raw segmented toggle for visual continuity.
- [x] 10.2 Update `design/preview.html` to render both filter bars with: (a) AND-toggle selected, (b) OR-toggle selected, (c) per-row Apply button visible on each row. Verify in browser.
- [x] 10.3 Confirm focus halos on the new segmented toggle and on `RowApplyButton` match `--accent-glow` per the visual system.

## 11. Final verification

- [x] 11.1 Run the full unit-test suite (`pnpm test` / `cargo test`) — all green. Results: 677 JS tests passed (64 files, 1 file skipped), 373 Rust tests passed (1 ignored), 0 failures.
- [x] 11.2 `openspec validate improve-filter-bar-shortcuts-combinator` — passes. Output: "Change 'improve-filter-bar-shortcuts-combinator' is valid".
- [x] 11.3 Manual end-to-end pass against a real Postgres connection: `⌘F`, per-row Apply, AND→OR toggle, OR-root with OR-group child, persistence across tab close/reopen, persistence across app restart.
- [x] 11.4 Manual end-to-end pass against a real Dynamo connection: same flows scoped to filters section; verify `KeyConditionExpression` untouched by per-row Apply.
- [x] 11.5 Open a fresh table tab whose persisted filter pre-dates this change — confirm it loads as AND with no warnings.
