## Context

The existing Argus filter bar (see `src/modules/postgres/data/filter-bar/FilterBar.tsx`) is a structured-or-raw, always-visible component with nested OR groups, inline AND/OR root toggle, ⎋ discard, `Reset`, mode toggle, and a per-row Apply on a `▶` icon. Its model lives in `src/modules/postgres/data/types.ts` as a `FilterTree` with `FilterNode = condition | or_group` and a `FilterModel = { mode, tree, raw }`. The wire shape (Tauri command `postgres_query_table`) accepts `filter_tree` OR `raw_where` (mutually exclusive).

This change re-anchors the bar to the **TablePlus reference design**: hidden by default, flat row list, per-row checkbox + Apply, footer with `Apply All` + shortcut hints. The product trade is intentional: we shed nested OR groups, Raw SQL mode, and the discard/reset duo to gain the dense, keyboard-driven TablePlus flow that our power-user audience already knows from competing tools.

Constraints we honor:
- DESIGN.md tokens drive every visual choice; no ad-hoc colors. `--success` (`#4ADE80`) is the natural token for the "Applied" green; a new `--success-soft` tint is added to DESIGN.md (consistent with the existing `--accent-soft` pattern).
- The Tauri backend keeps its current contract — we do **not** rev the wire protocol. `or_group` stays valid in the parser; the frontend simply never emits it. `raw_where` stays valid (the SQL Editor still uses it).
- Per-table viewer settings already exist (page size, column widths). We extend that store rather than introducing a new persistence layer.
- All keyboard handlers must continue respecting the existing CodeMirror carve-out (don't steal keys when focus is inside a `.cm-editor`).

## Goals / Non-Goals

**Goals:**
- Visually and behaviorally match TablePlus's filter bar for the operations the user identified (hidden by default, per-row checkbox, per-row `Apply` → green `Applied`, `Apply All` with AND/OR chevron, footer shortcut hints, full keyboard control via `⌘F`, `⌘I`, `⌘⇧I`, `⌘↑`, `⌘↓`, `⌘←`, `⌘↵`, `⇧⌘↵`, `Unset`).
- Preserve current filter semantics on the wire (no backend break).
- Preserve `applied` filter state and the data grid's response to filter changes (buffer reset, count invalidation, activity-log emission).
- Migrate persisted legacy `FilterModel`s gracefully — never crash the viewer on load.

**Non-Goals:**
- Implementing `Export` (CSV/JSON). The button ships as a disabled placeholder with a follow-up TODO.
- Reordering rows via drag or `⌘↑/⌘↓` (those move focus only).
- Touching the SQL Editor's Raw WHERE handling. `compileWhere`'s output is still consumed by `Open in SQL Editor`.
- Per-column header filter popovers (already removed by a prior change; we keep it that way).
- Multi-select on the column picker or BETWEEN/IN improvements — operator surface stays as-is.
- Real-time filtering (Apply remains explicit).

## Decisions

### D1. Visibility lives in a per-table viewer setting, defaulting to hidden

**Choice:** Extend the existing per-table viewer settings hook (`useColumnWidthPreferences` / `usePageSize` pattern) with a new `useFilterBarVisible(connectionId, schema, relation)` hook. Default `false`. Persisted across app restarts via the same SQLite-backed settings store. Toggle is exposed via (a) a new `Filter` icon button in the table tab chrome (right side of `SubtabHeader`), and (b) the `⌘F` shortcut (now toggle, not focus-only).

**Why:** Per-table feels right — a user filtering a `users` table heavily wants the bar open every time they revisit it; a user inspecting a one-off `audit_log` doesn't. Per-tab would lose preference on reopen. Global would override user intent across tables. The existing per-table settings pattern is already battle-tested.

**Alternatives considered:**
- Per-tab in-memory only → lose intent on reopen; bad UX.
- Global setting → wrong granularity; users keep `users` filtered but not `pg_class`.
- Always-visible (no toggle) → contradicts the proposal's "no space when unused" goal.

### D2. `⌘F` becomes a true toggle; if hidden, show + focus first row; if visible and unfocused, just focus; if visible and already focused, hide

**Choice:** State machine for `⌘F`:
```
hidden, focus outside bar      → show + focus first row's value input
visible, focus outside bar     → focus first row's value input
visible, focus inside bar      → hide (preserve draft in memory)
```

**Why:** This matches TablePlus's behavior and gives the user one shortcut that "does the right thing" regardless of current state. The "hide when focused inside" arm makes `⌘F` a real toggle rather than a one-way show.

**Alternatives considered:**
- Two separate shortcuts (show vs hide) → noisier; users have to learn two.
- `⌘F` always toggles regardless of focus → can't focus into an already-visible bar without an extra click.
- `Esc` to hide instead → conflicts with the removed "discard draft" semantics.

### D3. Data model: flat `Condition[]` with `enabled: boolean` per row, plus persistent `combinator`

**Choice:** Rewrite `FilterTree` to:
```ts
interface FilterRow {
  enabled: boolean;       // checkbox state — gates inclusion in Apply All
  column: ColumnRef;
  op: Operator;
  value?: FilterValue;
}
interface FilterTree {
  rows: FilterRow[];
  combinator: "AND" | "OR";  // persisted across Applies, default "AND"
}
type FilterModel = FilterTree;  // mode + raw fields removed
```
Drop `FilterNode` union; drop `or_group`; drop `mode` and `raw` from `FilterModel`. `getRootCombinator(tree)` simplifies to `tree.combinator`. `modelToPayload(model)` becomes:
```ts
function modelToPayload(model: FilterModel): { filter_tree?: FilterTree } {
  const enabled = model.rows.filter(r => r.enabled && isComplete(r));
  if (enabled.length === 0) return {};
  return { filter_tree: { rows: enabled, combinator: model.combinator } };
}
```
The wire shape mapping in the compiler must emit `{ children: [...condition leaves], combinator }` on the wire (preserving the backend's existing `FilterNode` schema — we just never emit `or_group`).

**Why:** The flat list is the simplest possible representation that supports the new UI. The `enabled` flag belongs on the row (UI state) rather than at the tree level — it's natural in the checkbox column. The persistent combinator on the tree object means a single source of truth for AND/OR; the chevron menu mutates it.

**Alternatives considered:**
- Keep `FilterNode` union for forward-compat → dead weight; we said BREAKING; YAGNI.
- Put `enabled` in a parallel `Set<number>` keyed by row index → fragile when rows are added/removed; index drift bugs.
- Two trees (draft + applied) with separate `enabled` filters → makes the "applied row" detection harder; the single-tree-with-flag approach is cleaner.

### D4. Per-row green "Applied" state derived from structural equality with `applied`

**Choice:** A row is rendered as **Applied** (green badge, green tint on the input) when there exists a row in `applied.rows` (the **last successfully-fetched** filter set) that is **structurally equal** to the draft row — same `column`, same `op`, same `value`, **regardless of `enabled` state**. This is computed with the existing `filterValueEquals` helper, generalized to a row-level `filterRowEquals`. The mapping is a `Set<number>` of draft row indices in applied state, recomputed on every render via `useMemo` keyed on `(draft.rows, applied.rows)`.

Editing any field on an applied row immediately drops it out of the applied set (because structural equality breaks) → badge flips to gray `Apply`. Re-running per-row Apply (or `Apply All`) re-adds it.

**Why:** Structural equality is the only sound definition of "this row is currently applied" — TablePlus does the same. Using `useMemo` keeps it cheap.

**Alternatives considered:**
- Compare by row identity (UUID) → would require generating IDs and tracking them through Apply; adds complexity for no gain.
- Compare by `(column, op)` only → wrong; a user editing the value should drop the badge.
- Recompute on every keystroke without memo → cheap in practice (≤20 rows) but memo is free insurance.

### D5. `Apply All` semantics with persistent combinator

**Choice:** `Apply All` (button) and `⌘↵` set `applied` to a tree composed of:
- `rows`: the subset of `draft.rows` where `enabled === true` AND the row is "complete" (column + op + value present, where the op requires a value).
- `combinator`: `draft.combinator` (i.e., whatever was last picked in the chevron menu — persisted across Applies).

The chevron menu has two items:
1. `Apply All Checked Filters with AND – Default` `⌘↵`
2. `Apply All Checked Filters with OR` `⇧⌘↵`

Clicking item 1 sets `draft.combinator = "AND"` then fires Apply All. Clicking item 2 sets `draft.combinator = "OR"` then fires Apply All. The button's primary click (no chevron) uses whichever combinator is currently in `draft.combinator` — i.e., the button is a literal "Apply All" using the persisted choice. Item 1 / Item 2 are marked with a ✓ checkmark next to whichever matches `draft.combinator`, so the menu reflects the persisted state.

`⌘↵` is bound globally to the bar (when visible & focused inside) and forces AND-default Apply All (it changes `draft.combinator` to `"AND"` then applies — matches TablePlus's "Apply All Checked Filters with AND – Default" being the `⌘↵` shortcut). `⇧⌘↵` forces OR.

**Why:** This is the exact TablePlus mapping per the user's screenshot. Persistent combinator means a user who picked OR once doesn't have to re-pick on every Apply.

**Alternatives considered:**
- Have `Apply All` always use AND, OR-only via the chevron menu → mismatches TablePlus and forces extra clicks for OR-heavy users.
- Have `⌘↵` not mutate `combinator` (use the persisted value unchanged) → conflicts with the "Default" label on the menu item and TablePlus's shortcut.

### D6. Per-row `Apply` button replaces active filter with that one row (no combinator change)

**Choice:** Per-row Apply (button on every row, not just first) sets:
```ts
applied = { rows: [thisRow], combinator: draft.combinator }
```
The combinator is preserved (one row makes it moot, but the field round-trips). This matches today's `onApplyOnlyRow` semantics in `TableViewerTab.tsx:472`. The button's label and color reflect the per-row Applied state from D4.

**Why:** "Apply only this row" is a power-user gesture for "isolate this condition, see what it does"; it should be one click. Preserving `combinator` means subsequent edits don't lose the AND/OR choice.

**Alternatives considered:**
- Per-row Apply ADDS the row to applied set (additive) → confusing; conflicts with the per-row checkbox semantic which is already "include in Apply All".
- Per-row Apply leaves other applied rows in place → then what does the green state on the others mean? Ambiguous.

### D7. `Unset` clears all draft rows; `Esc` and per-row `×` are removed

**Choice:** `Unset` (in footer) → `draft = { rows: [emptyRow()], combinator: draft.combinator }` (preserves combinator; one empty row remains since the bar always shows at least one row when visible). It does NOT touch `applied` — to clear filtering, the user then presses `Apply All` (which sees no enabled+complete rows → no `filter_tree` payload → no WHERE). This is a two-step but explicit flow.

`Esc` no longer discards drafts. `Esc` does nothing inside the filter bar (the surrounding tab may still handle `Esc` for other affordances — that's out of scope).

The per-row `×` is gone — `−` per row removes the row (the entire row, not just clears it), unless it's the only row, in which case it clears the row's fields back to empty defaults (column=`any_column`, op=`Contains`, value=`""`, enabled=`true`).

**Why:** Matches TablePlus + the user's stated preference. "Unset replaces Reset" was explicit.

**Alternatives considered:**
- Make `Unset` also clear `applied` (one-click "no filter") → then `Apply All` after Unset would be redundant. But the two-step model is consistent with the rest of the bar (draft → Apply All).
- Keep `Esc` as a no-op-but-blur affordance → not needed; just remove the handler.

### D8. Row insert / remove keyboard semantics

**Choice:**
- `⌘I` (Insert): inserts a new empty row **immediately below the currently focused row**. If no row is focused inside the bar, insert at the end. New row defaults: `enabled=true`, `column=any_column`, `op=Contains`, `value=""`. Focus moves to the new row's column picker.
- `⌘⇧I` (Remove): removes the currently focused row. If the focused row is the last row remaining, clear its fields back to empty defaults instead. Focus moves to the row above (or stays on the now-empty row if it was last).
- `⌘↑` / `⌘↓` (Up/Down): move focus to the same logical control (column picker / op picker / value input) of the row above or below. Wraps at top/bottom (TablePlus does NOT wrap — we follow TablePlus, no wrap).
- `⌘←` (Columns): opens the column picker dropdown on the focused row (i.e., the same control the user would click). If focus is not on a row, no-op.

All shortcuts only fire when the bar is **visible**, the bar is **focused** (or the focus is inside one of its inputs), AND focus is NOT inside a CodeMirror surface.

**Why:** Standard "insert below current" matches every editor; "remove focused, clear if last" is the only sensible interpretation that doesn't auto-hide the bar.

**Alternatives considered:**
- `⌘I` inserts at end always → loses positional intent.
- `⌘⇧I` on last row hides the bar → contradicts the "hide is explicit (⌘F or button)" model.
- `⌘↑/↓` reorder rows → user explicitly asked for "foco" (focus); reordering would require additional UI.

### D9. Footer layout is one strip; `Export` is a disabled placeholder

**Choice:** Footer is a single horizontal flex row, left-aligned shortcut hints and the `Unset` + `Export` + `SQL` triplet, right-aligned `Apply All` + chevron. Visually:
```
[Export][SQL]  Show:⌘F  Insert:⌘I  Remove:⌘⇧I  Apply All:⌘↵  Up:⌘↑  Down:⌘↓  Columns:⌘←  Operator:[Unset]      [Apply All ▾]
```
`Export` is rendered with `disabled` + `aria-disabled="true"` + `title="Export coming soon"`. `SQL` opens the SQL Editor with the current `applied` (NOT `draft`) compiled WHERE prefilled — same behavior as today's `Open in SQL Editor`.

Shortcut hints use the existing `FilterKeyHint` component (already in `src/modules/shared/filter-bar/`).

The gear icon (`⚙`) seen in the TablePlus screenshot is **omitted** per user direction.

**Why:** Single-row footer is denser, mirrors TablePlus. Disabled Export keeps the visual parity without committing to scope creep.

**Alternatives considered:**
- Two-row footer (shortcuts on one, buttons on another) → wastes vertical space we just clawed back.
- Implement Export now → out of scope; would balloon the change.

### D10. Migration: legacy `FilterModel`s reset to empty

**Choice:** When loading a persisted `FilterModel` (from any cache or settings), if its shape doesn't match the new `{ rows, combinator }` flat structure, OR if `mode === "raw"` is present in the legacy shape, OR if any child node in the legacy tree has `kind === "or_group"`, **reset to `EMPTY_FILTER_MODEL`**. No salvage attempt. A `console.info` log records the migration for debugging.

**Why:** User explicitly approved "estan vacios en upgrade". The migration code is a 5-line type guard; trying to salvage raw WHERE strings or flatten OR groups into AND/OR siblings is bug-prone and zero-value.

**Alternatives considered:**
- Flatten OR groups by joining child conditions with the root combinator → semantics change silently; worse than empty.
- Preserve raw WHERE in a new "external filter" slot → no UI exists for it.

### D11. Backend stays tolerant; we change types only on the frontend

**Choice:** The backend `FilterTree` / `FilterNode` Rust enum stays as-is. `or_group` remains a valid variant on the wire. The new frontend simply never emits `or_group` children. `raw_where` likewise stays — `Open in SQL Editor` (via `compilePrefilledSelect`) still uses the compiled WHERE body, and the SQL Editor itself uses `raw_where` for its own paths (no change). The `postgres-data-grid` spec is updated to remove the *user-facing surface* of those features (no Raw mode, no OR-group UI), while keeping the wire requirements intact.

**Why:** Lower risk; no Rust changes; no Tauri command versioning needed.

**Alternatives considered:**
- Strip `or_group` and `raw_where` from the backend too → breaks the SQL editor's raw path and breaks any other client; pure cost.

### D12. New `--success-soft` token in DESIGN.md for applied-row tint

**Choice:** Add to DESIGN.md:
```
| --success-soft | rgba(74,222,128,0.12) | Filter row "applied" input tint |
```
Matches the existing `--accent-soft` pattern. The "Applied" badge uses `--success` for its border + text, transparent fill. The row's value input gets `background: var(--success-soft)` and a 1px `border: var(--success)` (or rather a slightly darker shade — to be tuned at implementation time).

**Why:** Token discipline — DESIGN.md is the source of truth. Reusing `--success` (#4ADE80) reads as "this is operating, this is live", which matches TablePlus's green.

**Alternatives considered:**
- Ad-hoc `rgba(...)` in CSS → violates DESIGN.md discipline.
- A new `--applied` token → unnecessary alias.

## Risks / Trade-offs

- **[Loss of expressivity for power users]** — Some users may rely on the current OR groups or Raw SQL mode. → Mitigation: `Open in SQL Editor` still works; advanced predicates move to that surface, where the user can hand-write any WHERE.
- **[Migration data loss]** — Persisted filters with `raw` mode or OR groups are dropped to empty. → Mitigation: user explicitly approved; the affected population is likely tiny; a one-line `console.info` makes it debuggable.
- **[Shortcut collisions]** — `⌘I`, `⌘⇧I`, `⌘↑/↓`, `⌘←` may collide with platform / webview defaults (`⌘I` is "italic" in some contexts; `⌘↑/↓` is "scroll to top/bottom" in others). → Mitigation: all handlers gate on `bar visible && focus inside bar && not in CodeMirror`, call `preventDefault()`, and a manual QA pass on macOS + Linux is added to tasks.
- **[Per-row Apply UX confusion]** — Users may not understand the difference between per-row Apply (replaces) and Apply All (composes). → Mitigation: button tooltip on the row Apply reads `"Apply only this row (replaces active filter)"` (kept verbatim from today). The chevron-menu items are explicit about "Checked Filters". Both are aligned with TablePlus's existing model, which is widely understood.
- **[Persistent combinator surprise]** — A user who picked OR last week reopens a table and is confused when AND-shaped filters apply as OR. → Mitigation: the `Apply All` button visually annotates the combinator when it's OR (e.g., subtle `[Apply All · OR]` label, or a small `OR` chip — exact treatment to be picked during implementation). To be verified during design-review.
- **[Migration false positives]** — A perfectly-valid new-shape model might be misidentified as legacy. → Mitigation: type guard checks for presence of new-shape fields (`rows`, `combinator`) AND absence of legacy fields (`mode`, `tree`); two independent signals minimize the chance.
- **[Visual feedback for "no enabled+complete row"]** — If the user clicks Apply All with no enabled rows, the bar must NOT silently clear filters without indication. → Mitigation: Apply All in that state shows a brief inline status ("no filters enabled"), and the BottomBar `filterCount` updates to 0 as today.

## Migration Plan

1. **Phase 1 (this change):**
   - Land the new types and migration shim first; existing UI temporarily reads new types via an adapter (to keep the app bootable mid-change).
   - Rewrite `FilterBar.tsx`, `ConditionRow.tsx`, delete `OrGroup.tsx`, `RawWhereEditor.tsx`, `ConfirmDialog.tsx`.
   - Update `TableViewerTab.tsx` handlers (toggle on `⌘F`, new shortcuts, new toggle button in `SubtabHeader` chrome).
   - Add `useFilterBarVisible` hook + settings backing.
   - Rewrite tests.
   - Update `postgres-data-grid` spec deltas.
2. **No rollback complexity:** users on older builds keep working (backend tolerates everything). Users on the new build get the new UI; their legacy persisted filters reset to empty.

## Open Questions

- **OR-active visual annotation on `Apply All` button** — should it be a chip, a label suffix, or just the menu checkmark? Punt to implementation; defaults to checkmark-only and reviewed at design-review.
- **`Filter` toggle button placement in `SubtabHeader`** — exact pixel position (left of subtab tabs, right of them, or in a dedicated icon strip) — punt to implementation; default is right-of-subtab-tabs, aligned with other tab chrome icons.
- **Should the bar auto-show on the first visit to a table that has no persisted preference?** Default: **no**, always hidden by default per user direction. To revisit if power users complain.
