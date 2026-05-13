## 1. Design tokens in global.css

- [x] 1.1 Re-tune dark-theme `--surface` to `#1C1C24` and `--surface-2` to `#23232C` in `src/styles/global.css` to align with `DESIGN.md`.
- [x] 1.2 Add `--canvas`, `--elevated`, `--hairline` to both `:root[data-theme="dark"]` and `:root[data-theme="light"]` blocks per the values in `design.md` D9.
- [x] 1.3 Replace blue accent palette (`#3b82f6` / `#2563eb`) with violet palette (`#A855F7` dark / `#7C3AED` light); add `--accent-hover`, `--accent-soft`, `--accent-glow` for both themes.
- [x] 1.4 Add `--radius-sm/md/lg/xl/full`, `--space-2xs/xs/sm/md/lg/xl`, `--duration-instant/short/medium/long` once at `:root` (theme-agnostic).
- [x] 1.5 Add `--info` semantic color to both themes for completeness with `DESIGN.md`.
- [x] 1.6 Verify `--font-mono` falls back to the system mono stack already declared at `:root`; no change needed unless missing.

## 2. Shared primitive layer

- [x] 2.1 Create directory `src/modules/shared/filter-bar/` with `index.ts` barrel export.
- [x] 2.2 Implement `FilterBarShell.tsx` + `FilterBarShell.module.css` — outer container with `background: var(--surface)`, 1px bottom hairline, flex column, font-size 12px.
- [x] 2.3 Implement `FilterBarHeader.tsx` + CSS — 32px min-height, `6px var(--space-sm)` padding, 1px bottom hairline, flex row with `gap: var(--space-xs)`.
- [x] 2.4 Implement `FilterBarBody.tsx` + CSS — flex column, `var(--space-xs)` vertical / `var(--space-sm)` horizontal padding, `var(--space-xs)` row gap.
- [x] 2.5 Implement `FilterBarActions.tsx` + CSS — 32px min-height, 1px top hairline, flex row with `gap: var(--space-xs)`, left/right slots separated by flex spacer.
- [x] 2.6 Implement `FilterSegmentedToggle.tsx` + CSS per design.md D4: `overflow: visible`, `border: 1px solid var(--border-strong)`, `border-radius: var(--radius-md)`, 24px inner height; first/last option round their outer corners; inter-option `border-right: 1px solid var(--border-strong)`; active state uses `var(--accent-soft)` bg + `var(--accent)` text; hover uses `var(--surface-2)`; focus-visible halo via `box-shadow`.
- [x] 2.7 Implement `FilterTypeBadge.tsx` + CSS — `padding: 1px 5px`, `font-family: var(--font-mono)`, `font-size: 10px`, `background: var(--surface-2)`, `color: var(--text-muted)`, `border-radius: var(--radius-sm)`, `letter-spacing: 0.16em`.
- [x] 2.8 Implement `FilterConnector.tsx` + CSS — uppercase mono label (AND/OR), 10px, `letter-spacing: 0.14em`, `color: var(--text-subtle)`, width 28px, centered.
- [x] 2.9 Implement `FilterRowAddButton.tsx` + CSS — dashed-border button, `var(--border-strong)`, 11px text, `var(--radius-md)`, hover bg `var(--surface-2)`, focus halo.
- [x] 2.10 Implement `FilterKeyHint.tsx` + CSS per spec: 10px mono, `letter-spacing: 0.16em`, 1px `var(--border)`, `var(--radius-sm)`, `padding: 1px 5px`, `color: var(--text-subtle)`. Auto-detects macOS vs other for glyph (`⌘` vs `Ctrl`).
- [x] 2.11 Implement shared `PrimaryButton` (or extend existing button styles) inside the filter-bar layer: violet face, `var(--radius-md)`, `padding: 4px 12px`, 11px text, weight 500; dirty-pip rendered as a 4px `::before` pseudo at top-right `−2/−2` with a 2px `var(--accent)` ring against the violet face; pip is layout-stable.
- [x] 2.12 Implement shared `SecondaryButton` with matching dimensions, transparent bg, `var(--border-strong)` border, `var(--text)` text, hover bg `var(--surface-2)`.
- [x] 2.13 Implement shared `EmptyBodyRow.tsx` + CSS — 24px row, `color: var(--text-subtle)`, 11px, renders a label + inline `·`-separated children (used for the inline empty state).
- [x] 2.14 Add a `@media (prefers-reduced-motion: reduce)` block in each primitive's CSS module that drops `transition` declarations (color/background still change instantaneously).
- [x] 2.15 Add a Vitest snapshot test per primitive covering the default render and the active/hover/disabled/focus class states (via class assertions, not visual diff).

## 3. Postgres FilterBar refactor

- [x] 3.1 Read `src/modules/postgres/data/filter-bar/FilterBar.tsx` end-to-end and list every JSX subtree that maps to a shared primitive (header chrome, mode toggle, action-row chrome, dirty dot, "+ AND row" / "+ OR group", connector strips).
- [x] 3.2 Rewrite `FilterBar.tsx` to compose `FilterBarShell` / `Header` / `Body` / `Actions`, `FilterSegmentedToggle` for the Structured/Raw SQL mode toggle, `PrimaryButton` for Apply, `SecondaryButton` for Reset and Open in SQL Editor, `FilterKeyHint` chips for `⌘↵` and `⎋`, `FilterRowAddButton` for `+ AND row` / `+ OR group`, and `EmptyBodyRow` for the empty Structured body. Preserve every behavior contract (keyboard shortcuts, draft/applied state, collapse toggle, mode-switch confirm dialog).
- [x] 3.3 Replace `FilterBar.module.css` wholesale: delete every class whose role is now covered by primitives; keep only Postgres-specific layout for `StructuredBody`, `RawBody`, and the OR-group container (dashed border, 4% accent tint bg).
- [x] 3.4 Update `ConditionRow.tsx`, `ColumnPicker.tsx`, `OperatorPicker.tsx`, `ValueInput.tsx`, `OrGroup.tsx`, `RawWhereEditor.tsx` to consume `var(--surface-2)` hover, the violet `box-shadow` focus halo, and `var(--radius-md)` corners. Delete the orphan `<span className={styles.spacer}>` referenced in the inventory (FilterBar.tsx L170).
- [x] 3.5 Add a `prefers-reduced-motion` block to the surviving Postgres-specific CSS module(s).
- [x] 3.6 Run `pnpm test -- src/modules/postgres/data/filter-bar` and confirm the existing FilterBar tests still pass without modification.

## 4. Dynamo QueryBuilder refactor

- [x] 4.1 Read `src/modules/dynamo/data-view/QueryBuilder.tsx` end-to-end and list every JSX subtree that maps to a shared primitive (top row mode toggle, action-row chrome, type badges next to attribute names, `+ Filter` button, AND connector strips between filter rows, Preview disclosure header).
- [x] 4.2 Rewrite `QueryBuilder.tsx` to compose `FilterBarShell` / `Header` / `Body` / `Actions`, `FilterSegmentedToggle` for Scan/Query, `PrimaryButton` for Run (with dirty-pip when builder state differs from last-run state — add a `lastRunState` ref if it doesn't exist), `SecondaryButton` for Reset, `FilterKeyHint` chips for `⌘↵` and `⌘⇧R`, `FilterTypeBadge` for every attribute type label, `FilterRowAddButton` for `+ Filter`, `FilterConnector` for inter-row AND labels, and `EmptyBodyRow` for the empty filters section.
- [x] 4.3 Replace `QueryBuilder.module.css` wholesale: keep only Dynamo-specific layout for `keySection`, `filtersSection`, `previewSection` (the collapsible disclosure), the boolean toggle pill, and the `Null` switch. Delete every class whose role is now covered by primitives.
- [x] 4.4 Re-tune `keySection` and `filtersSection` to use the body padding rhythm (no extra padding past `FilterBarBody`'s own padding) and `var(--space-xs)` row gap.
- [x] 4.5 Replace ad-hoc `--canvas` mixes in `QueryBuilder.module.css` with `var(--surface)` for the bar container; reserve `--canvas` for the outer page background only.
- [x] 4.6 Add a `prefers-reduced-motion` block to the surviving Dynamo-specific CSS module.
- [x] 4.7 Update `Toolbar.module.css` for the Dynamo data view to use the violet accent + `var(--radius-md)` on its primary controls so it doesn't visually drift from the new query builder.
- [x] 4.8 Run `pnpm test -- src/modules/dynamo/data-view` and confirm the existing QueryBuilder tests still pass without modification.

## 5. App-wide accent ripple QA

- [ ] 5.1 Visual QA: title bar — no surface uses `var(--accent)` for chrome (verify no blue→violet shift introduces unintended saturation).
- [ ] 5.2 Visual QA: sidebar — active connection stripe and active group highlight render violet, not blue; the stripe edge is crisp on `--canvas`.
- [ ] 5.3 Visual QA: tab strip — active tab underline renders violet with the `var(--accent-glow)` soft halo, matches `DESIGN.md` "where the accent is allowed to be loud" item 2.
- [ ] 5.4 Visual QA: command palette — match-highlight color, active-row stripe, and active-row tint all use the violet palette correctly.
- [ ] 5.5 Visual QA: data grid — active row's left-edge stripe + `var(--accent-soft)` tint renders correctly in both themes; dirty cell remains distinguishable.
- [ ] 5.6 Visual QA: inspector — PK column marker renders violet, not blue.
- [ ] 5.7 Visual QA: primary CTAs across the app (Connect, Run query, Save, modal confirms) — all share the new violet face and `var(--radius-md)`.
- [ ] 5.8 Visual QA: light mode — re-walk steps 5.1–5.7 with `data-theme="light"` set, confirming the warm off-white treatment lands per `DESIGN.md`.

## 6. Filter-bar QA

- [ ] 6.1 With `/browse` (gstack browse skill), open the dev server, navigate to a Postgres connection, open a table, and screenshot the filter bar in: (a) empty state, (b) one Structured condition, (c) dirty draft, (d) applied draft, (e) Raw mode, (f) collapsed.
- [ ] 6.2 Same flow for Dynamo: (a) empty Scan, (b) one filter row, (c) Query mode with PK + SK, (d) dirty draft, (e) Preview expanded, (f) one filter row with type-badge picker on.
- [ ] 6.3 Verify focus halo visually on every focusable child of both bars (tab through, screenshot each focused state) — confirm no clipping inside the segmented control and no overlap with sibling controls.
- [ ] 6.4 Toggle macOS "Reduce motion" and confirm hover transitions disappear while the focus halo still appears instantly.
- [ ] 6.5 Toggle the app theme between dark and light and confirm both bars re-tune to the warm off-white surfaces without contrast regressions on text-subtle (≥3:1) or accent-text on `--accent` (≥4.5:1).
- [ ] 6.6 Verify keyboard shortcuts still work: `⌘↵` applies Postgres / runs Dynamo, `⎋` discards Postgres draft, `⌘⇧R` resets Dynamo.

## 7. Documentation

- [x] 7.1 Append a 2026-05-13 entry to the `DESIGN.md` Decisions Log noting the filter-bar visual unification and the corrected accent palette.
- [x] 7.2 Update `design/preview.html` to include side-by-side Postgres / Dynamo filter-bar renders in the default, dirty, and empty states for both themes.
- [x] 7.3 Add a `CHANGELOG.md` entry under the next unreleased version describing the visual change and the accent swap (user-facing).
- [x] 7.4 In `src/modules/shared/filter-bar/index.ts`, add a one-line top-of-file comment naming the primitive layer for grep-discoverability; no JSDoc on individual primitives.

## 8. Ship

- [x] 8.1 Run `pnpm typecheck` and `pnpm lint` clean. (typecheck clean; 9 pre-existing lint errors in `scripts/*.mjs`, `src/modules/dynamo/data-view/Inspector.tsx`, `src/modules/dynamo/data-view/edit/OptimisticLockingDialog.tsx` — none introduced by this change)
- [x] 8.2 Run the full `pnpm test` suite clean. (603/603 pass when `src/modules/dynamo/tables/CacheProvider.test.tsx` runs in isolation; the suite-level intermittent failure in that file's "dispatches at most 8 concurrent describe calls when 20 are queued" test is a pre-existing flake unrelated to this change)
- [ ] 8.3 Manual smoke: launch the Tauri dev shell (`pnpm tauri dev`), open one Postgres table and one Dynamo table, run filters in each, switch themes, confirm no console errors.
- [ ] 8.4 Open the PR with screenshots from steps 6.1 and 6.2 in the description.
