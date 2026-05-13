## Why

The filter bar is one of the most-used surfaces in Argus — every Postgres table viewer and every Dynamo data view mounts one — and today it has three frustrating papercuts:

1. **No keyboard entrypoint.** The bar is mouse-only. To start filtering, the user must reach for the mouse, click into the empty state, click the `+ AND row` button, then click the column picker. Other "find" surfaces in desktop apps universally respond to `⌘F` / `Ctrl+F`; ours doesn't. Worse, when the bar is collapsed (`collapsed = true` in `FilterBar.tsx`), there is no shortcut to expand it at all.
2. **Apply is all-or-nothing.** The draft → applied flow assumes the user wants to commit every row at once. There is no way to say "run just this condition" or "preview what this single predicate would return" without manually deleting the other rows from the draft and re-adding them after — high-friction for the iterative "what does this single filter buy me?" workflow that real database work requires.
3. **The root combinator is hard-coded to AND.** The root tree silently joins children with AND, and the only way to get an OR semantics at the top level is to wrap everything in a single OR group via the `+ OR group` affordance, which is awkward, visually heavy, and not symmetric with the `+ AND row` flow. Power users routinely want "match ANY of these" at the root and have to fight the UI for it.

This change addresses all three on both the Postgres `FilterBar` and the Dynamo `QueryBuilder` so the two stay visually and behaviorally interchangeable (per the `filter-bar-visual-system` contract established in 2026-05-13).

## What Changes

- **`⌘F` / `Ctrl+F` opens or focuses the filter bar.**
  - When the bar is collapsed → expand it AND move focus to the first interactive control in the body.
  - When the bar is expanded but focus is outside it → move focus to the first interactive control in the body (or to the empty-state `+ AND row` button if the body has no rows yet).
  - When the bar is expanded and focus is already inside it → move focus to the first row's column picker (a "go to top of filters" affordance).
  - Scope: shortcut only fires when the host tab (`postgres-table-data` Data subtab, or `dynamo-data-view` tab) is active AND keyboard focus is NOT inside a CodeMirror editor (the SQL editor / Raw WHERE editor must still handle their own `⌘F` if any). The Raw WHERE editor in the Postgres filter bar is an exception: `⌘F` there focuses the editor itself.
  - The shortcut does NOT register at the global window level (other tabs unaffected).
- **Per-row "Apply only this" affordance.**
  - Each root child in the Postgres `FilterBar` body gains a small `▶` icon-button at the row's right edge: `aria-label="Apply only this row"`. Activating it applies just that single child (replacing `applied` with a single-child tree, preserving the row's structure — including OR groups), without touching `draft`. Returning to the full draft is via the standard `Apply` (which still applies the whole draft).
  - Each filter row in the Dynamo `QueryBuilder` gains the same affordance, scoped to that filter row (the resulting compiled state has that filter and no others).
  - Per-row apply MUST respect the dirty pip (`isDirty`) — after applying just one row, the rest of the draft is still dirty relative to `applied`, so the Apply button still shows the pip.
- **Root combinator toggle (AND ↔ OR).**
  - The root tree gains an explicit `combinator: "AND" | "OR"` field, defaulting to `"AND"` (backward-compatible: existing persisted models without the field MUST be migrated to `"AND"` on load).
  - The UI renders a small segmented toggle next to the existing `+ AND row` / `+ OR group` add affordances: `AND | OR`. Switching toggles the connector pill text between every root child (currently always "AND") and re-compiles `WHERE …` with the chosen connector.
  - The compile path (`compileWhere`) joins root children with the chosen connector. OR groups are still allowed as nested children (root-OR + OR-group children means OR-of-OR, which flattens at compile; root-AND + OR-group means AND-of-OR, which is the current default).
  - When the user toggles to OR with a single root child that is an OR group, the UI MAY unwrap the group (offered as a one-click "Flatten?" affordance), but this is a polish nicety, not required for correctness.
  - The Dynamo `QueryBuilder` gains the same toggle for its filters section (whose rows currently always combine with AND).
- **Backend wire payload extension.**
  - The Rust `FilterTree` struct gains an optional `combinator: "AND" | "OR"` field with default `"AND"` (`#[serde(default)]`). The SQL compiler joins root children with that connector. Schema-validation tests cover the OR-root case.
  - The Dynamo compiler (`builderCompiler.ts`) gains the same field for the filters section, joined into the `FilterExpression` with the chosen connector.

Non-goals:
- No new operators. No new column ref kinds. No changes to raw-WHERE mode. No changes to OR-group nesting depth (still 1 level).
- No batch "apply selected rows" multi-select — only single-row apply and full-draft apply.
- No `⌘G` / "find next" / cell-text-search semantics. `⌘F` is a focus shortcut, not a cell-text-search shortcut. (Cell-text-search is a separate future change.)
- No mouse-hover-only affordances — the per-row Apply button is always visible (per `DESIGN.md`'s no-hover-discovery rule).

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `postgres-data-grid`: The "Filter bar surface" requirement gains the `⌘F` shortcut, the per-row Apply affordance, and the root-combinator toggle. New scenarios; no existing scenarios contradicted.
- `dynamo-data-view`: The "Structured query builder" requirement gains the same three additions, scoped to the filters section. New scenarios; no existing scenarios contradicted.

## Impact

- **Code:**
  - `src/modules/postgres/data/types.ts`: add `combinator?: "AND" | "OR"` to `FilterTree`, with helpers (`EMPTY_FILTER_TREE`, `filterTreeEquals`) updated.
  - `src/modules/postgres/data/filter-bar/treeMutations.ts`: add `setRootCombinator` mutation.
  - `src/modules/postgres/data/filter-bar/compileWhere.ts`: join root children with `tree.combinator ?? "AND"`.
  - `src/modules/postgres/data/filter-bar/FilterBar.tsx`: add `⌘F` handler, per-row Apply button, root-combinator toggle, single-row apply callback.
  - `src/modules/shared/filter-bar/`: add a shared `RootCombinatorToggle` primitive (segmented control variant) and a `RowApplyButton` primitive.
  - `src/modules/dynamo/data-view/QueryBuilder.tsx` + `types.ts` + `builderCompiler.ts`: mirror changes for the filters section.
  - `src/modules/postgres/data/useTableFilter.ts`: migration shim — when reading a persisted `FilterModel` without `combinator`, default to `"AND"`.
  - `src/modules/postgres/data/TableViewerTab.tsx`: scope the new `⌘F` handler to the active tab + Data subtab; skip when focus is in CodeMirror.
  - `src/modules/dynamo/data-view/DataViewTab.tsx` (or wherever the tab root lives): same scoping.
- **Rust:**
  - `src-tauri/src/modules/postgres/data/filter.rs` (or wherever `FilterTree` lives): add `combinator` field with `#[serde(default)]`.
  - The compiler that emits `WHERE` for `filter_tree` joins root children with `AND` or `OR` as specified.
  - Existing unit tests for the AND-root case keep passing without modification; new tests cover OR-root and mixed-OR-group cases.
- **Persistence:**
  - `useTableFilter` reads/writes `combinator` in the same settings entry. Older entries (without the field) load as `"AND"`. No migration sweep needed — natural on-write upgrade.
- **Tests:**
  - Unit: `treeMutations.test.ts`, `compileWhere.test.ts`, `FilterBar.test.tsx` add cases for combinator + per-row Apply + `⌘F`.
  - Unit: `QueryBuilder` tests add cases for combinator + per-row Apply + `⌘F`.
  - Backend: `filter.rs` compiler tests add OR-root cases.
- **Docs:**
  - `DESIGN.md` decisions log gets a 2026-05-13 entry noting the combinator toggle and `⌘F` shortcut.
  - `design/preview.html` re-renders both filter bars with the new combinator toggle visible.
- **Risk:**
  - Wire compatibility — the Rust side MUST tolerate the field's absence (`#[serde(default)]`) so a forward-incompatible roll-out doesn't break older clients. Mitigated by serde defaults.
  - Conflict with `⌘F` in CodeMirror: the Raw WHERE editor handles its own find affordance — confirm CodeMirror's default `⌘F` (the search panel) still works inside the Raw editor and our handler does not preventDefault when focus is there.
  - Visual regression on the existing `+ AND row` / `+ OR group` add buttons when the combinator is `OR` (the inline "AND" connector pills must re-read as "OR").
