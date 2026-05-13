## Context

The Postgres `FilterBar` and Dynamo `QueryBuilder` were unified onto a shared `filter-bar-visual-system` in 2026-05-13 (`src/modules/shared/filter-bar/`). They share visual primitives but each owns its own state, mutation model, and compile pipeline:

- **Postgres** (`src/modules/postgres/data/filter-bar/`)
  - Model: `FilterModel { mode, tree, raw }` where `tree: FilterTree { children: FilterNode[] }` and root children combine implicitly with `AND`. OR is only possible via an `or_group` child node.
  - Mutations: pure functions in `treeMutations.ts` (`addRootCondition`, `addRootOrGroup`, `removeRootChild`, `setRootChild`, etc.).
  - Compile: `compileWhere.ts` → joins root children with `" AND "`; OR groups join their children with `" OR "` and wrap in parens.
  - Persisted via `useTableFilter` under a per-table settings key.
  - Keyboard: scoped `Cmd+Enter` (apply) and `Esc` (discard draft) handled by an `onKeyDown` on the bar's root div. Window-level `⌘1` / `⌘2` / `⌘3` (subtab switch), `⌘S` (save), `⌘Z` (undo) handled by `TableViewerTab.tsx`.
- **Dynamo** (`src/modules/dynamo/data-view/`)
  - Model: `BuilderState { mode, indexName, query, filters }` where `filters: FilterRow[]` and filters always combine with `AND`.
  - Compile: `builderCompiler.ts` produces `FilterExpression` and `KeyConditionExpression`; filter rows join with `" AND "`.
  - No persistence layer for the builder state (lives on the tab).
  - Keyboard: `Cmd+Enter` (run) is the only scoped shortcut (handled by parent `DataViewTab`).

Both bars are mounted inside their respective tab roots, both have a `collapsed` toggle (Postgres) or are always expanded (Dynamo), and both render through `FilterBarShell`.

Three product requirements (from the proposal):
1. `⌘F` opens/focuses the bar.
2. Per-row Apply ("apply just this one").
3. Root combinator toggle (AND ↔ OR).

The wire model (Postgres `FilterTree` → Rust struct) must accommodate the new combinator without breaking existing persisted state or older clients during a forward roll-out.

## Goals / Non-Goals

**Goals:**

- A single, scoped keyboard shortcut (`⌘F` on macOS, `Ctrl+F` on others) that brings keyboard focus into the filter bar with one keystroke, expanding the bar first if needed.
- A per-row affordance on every root child (Postgres) and every filter row (Dynamo) that applies only that row's predicate, leaving the rest of the draft untouched.
- A first-class root combinator toggle (AND ↔ OR) that is persisted alongside the rest of the filter draft and compiles correctly through the full Postgres SQL and Dynamo expression pipelines.
- Backward compatibility with existing persisted filter models (no migration required — `combinator` defaults to `AND`).
- Wire-format backward compatibility on the Rust side (`#[serde(default)]`).
- All new affordances surface on both bars (parity is part of the `filter-bar-visual-system` contract).

**Non-Goals:**

- Multi-row "apply selected" (only single-row and full-draft).
- Nested AND-of-AND or OR-of-OR-of-OR groups beyond one level. (Today's max depth: 2. We keep that.)
- `⌘G` / "find next" semantics.
- Cell-text search inside grid rows.
- A global window-level `⌘F` registry — the shortcut must remain tab-scoped to avoid stealing keystrokes from inactive tabs or other surfaces.
- Reworking raw-WHERE mode to honor the combinator (raw mode is opaque to the structured tree by definition).

## Decisions

### Decision 1: Keyboard shortcut scope

**Choice:** Handle `⌘F` via a `useEffect`-installed `keydown` listener on the active tab's root, NOT on `window` directly, and NOT inside the `FilterBar` component itself.

**Rationale:**
- The active-tab `useEffect` pattern is the established convention in `TableViewerTab.tsx` (`⌘S`, `⌘1`-`⌘3`, `⌘Z`).
- Installing on `window` and gating by `active` is functionally equivalent and is what the existing code does. We follow the same pattern.
- Handling inside `FilterBar` itself would require the bar to be focused to begin with — defeating the purpose of "open or focus the bar."
- Owning the handler at the tab level keeps the bar pure: it exposes an imperative ref (`filterBarRef.current.focus()`) and the tab routes the shortcut to it.

**API surface:**
```ts
// In src/modules/shared/filter-bar/index.ts
export interface FilterBarHandle {
  /** Expand if collapsed, then focus the first interactive control. */
  focus(): void;
}
```
The Postgres `FilterBar` and the Dynamo `QueryBuilder` MUST both accept `ref` (via `forwardRef`) and expose this `FilterBarHandle`. The host tab holds the ref and invokes `focus()` from the `⌘F` keydown handler.

**Skipped surfaces (must NOT trigger our handler):**
- CodeMirror editor (`.cm-editor` ancestor in the focus chain) — CodeMirror's built-in `⌘F` search panel keeps working.
- The Raw WHERE editor specifically (which IS a CodeMirror surface) — already handled by the CodeMirror check.
- `<input>` / `<textarea>` / `<select>` outside the filter bar: `⌘F` should still focus the bar. Today's `⌘S` handler skips editable surfaces, but for `⌘F` the user's intent is unambiguously "find/filter," so we DO preempt typing — same as Chrome/VS Code/etc. preempt `⌘F` while typing in a text field.

**Alternatives considered:**
- *Global hotkey via Tauri's `globalShortcut` plugin:* rejected — too aggressive (system-wide), conflicts with browser-style expectations, would steal `⌘F` even when Argus is in the background.
- *Inside-component `onKeyDown`:* rejected — fails when focus is on the grid or elsewhere.
- *Mitt / event bus dispatch:* rejected — adds infrastructure for a single shortcut.

### Decision 2: `FilterBarHandle.focus()` target selection

**Choice:** A small helper inside each filter bar component picks the focus target in this order:

1. If `collapsed === true` → `setCollapsed(false)` first (state update completes before focus on the next tick via `queueMicrotask` or `requestAnimationFrame`).
2. If the body has root children (Postgres) or filter rows (Dynamo) → focus the first row's column picker / attribute input.
3. If the body is empty → focus the `+ AND row` add button (the natural "next click" the user would make).
4. If the bar is in Raw mode (Postgres only) → focus the Raw WHERE editor textarea.

**Rationale:** Matches the user's mental model — `⌘F` lands them where they'd type/click next. Avoids the dead-end of focusing the mode toggle (Structured/Raw) which is rarely what the user wants.

**Implementation note:** The body's first interactive control is queried via a stable `data-filter-focus-target="true"` attribute that the body's first row renders. This avoids hardcoded CSS selectors and survives refactors of the row internals.

### Decision 3: Per-row Apply mechanism

**Choice:** A new callback `onApplyOnlyRow(index: number)` on `FilterBarProps` (Postgres) and `onApplyOnlyFilter(index: number)` on `QueryBuilderProps` (Dynamo). The host (TableViewerTab / DataViewTab) implements it by computing a single-child applied state from the current draft.

**Postgres implementation:**
```ts
// In TableViewerTab:
const onApplyOnlyRow = useCallback((index: number) => {
  const child = draft.tree.children[index];
  if (!child) return;
  const singleTree: FilterTree = {
    children: [child],
    combinator: draft.tree.combinator ?? "AND", // irrelevant with 1 child, kept for shape
  };
  const single: FilterModel = { ...draft, tree: singleTree };
  setApplied(single);
}, [draft, setApplied]);
```

The button is rendered inside `ConditionRow` (and `OrGroup` for OR-group root children) at the row's right edge, as a new shared primitive `RowApplyButton`.

**Dynamo implementation:** Mirrored — `onApplyOnlyFilter(index)` builds a `BuilderState` whose `filters` array has exactly that one entry, leaves `query` and `mode` and `indexName` alone, runs through `compile`, and calls the parent's `onRun` callback with that compiled state. The dirty pip recomputes against `lastRunStateRef`.

**Rationale:**
- Keeps the bar dumb (presentational); the host owns the applied state — matches the existing pattern (`onApply`, `onReset`).
- Symmetric with `onApply` and `onReset`.
- Per-row apply does NOT mutate `draft` — so the user can iterate one row, then click the global `Apply` to re-apply the whole draft.

**Alternatives considered:**
- *Mutate draft to drop other rows:* rejected — destructive; user loses their other rows.
- *Apply just this row as a separate "preview" channel:* rejected — adds a third state on top of `draft`/`applied`, doubles the complexity for marginal value.

### Decision 4: Root combinator data model

**Choice:** Add `combinator?: "AND" | "OR"` to `FilterTree` as an optional field; UI treats `undefined` as `"AND"`. Wire format: `serde(default)` on the Rust side. Persistence: read `combinator` from settings if present, write it always after this change.

**Why optional in TS but defaulted on read:**
- The TS type stays `combinator?: "AND" | "OR"` so existing test fixtures that build `FilterTree` objects don't need to be updated all at once. We provide a `getRootCombinator(tree): "AND" | "OR"` helper that returns the default.
- The Rust deserializer applies `default = "and_combinator"` so older clients writing a payload without the field don't break the backend; newer clients writing the field round-trip cleanly.
- New writers (mutations like `addRootCondition` after this change) ALWAYS write the field explicitly to avoid the silent-default trap.

**Rust shape:**
```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum RootCombinator { And, Or }

impl Default for RootCombinator {
  fn default() -> Self { RootCombinator::And }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FilterTree {
  pub children: Vec<FilterNode>,
  #[serde(default)]
  pub combinator: RootCombinator,
}
```

The SQL compiler joins root children with `" AND "` or `" OR "` based on `combinator`. Existing tests using `serde_json::json!({ "children": [...] })` (no `combinator` key) continue to pass because the default is `And`.

**Alternatives considered:**
- *Make `combinator` required on the wire:* rejected — breaks any in-flight persisted state and any test fixture not yet updated.
- *Encode the combinator at the node level (per-child):* rejected — non-uniform; one combinator per level is the SQL convention and matches user mental model.
- *Reuse `or_group` as the only OR mechanism by auto-wrapping when combinator is OR:* rejected — round-tripping is fragile and the wire format becomes ambiguous (is `[or_group(a, b)]` the same as `or-combinator + [a, b]`? They mean the same WHERE but compile differently).

### Decision 5: Root combinator UI placement

**Choice:** Render the toggle as a small inline pill inside `FilterBarBody`, positioned just below the rows, anchored to the left of the `+ AND row` / `+ OR group` add buttons. The pill shows the current combinator (`AND` / `OR`) and is a segmented control: clicking the inactive label flips the combinator.

When the combinator changes, every inter-row connector pill in the body re-reads to match (so `AND` connectors between rows become `OR` connectors). The add-button labels stay `+ AND row` / `+ OR group` regardless of the combinator — those refer to row TYPES (single condition vs. OR-group), not to the connector.

**Rationale:**
- Inline placement keeps the toggle physically adjacent to the rows it affects.
- Re-using the segmented-control primitive (`FilterSegmentedToggle`) is consistent with the Structured/Raw toggle in the header.
- Placing it next to the add buttons groups all "shape the row list" affordances together.

**Empty-state behavior:** When there are no rows, the combinator toggle is hidden (it has no semantic effect on an empty list). It re-appears once the first row is added.

**Dynamo equivalent:** A `AND | OR` toggle in the same position — below the filter rows, next to the `+ Filter` add button. Hidden when `filters.length === 0`.

### Decision 6: OR-group + root-OR interaction

**Choice:** Allow all four combinations:

| Root combinator | Row 1     | Row 2       | Compiled WHERE                                 |
|-----------------|-----------|-------------|------------------------------------------------|
| AND             | a = 1     | b = 2       | `a = 1 AND b = 2`                              |
| OR              | a = 1     | b = 2       | `a = 1 OR b = 2`                               |
| AND             | a = 1     | OR(b,c)     | `a = 1 AND (b OR c)`                           |
| OR              | a = 1     | OR(b,c)     | `a = 1 OR (b OR c)` (flattens semantically)    |

The compiler always parenthesizes OR groups. Root-OR + OR-group is allowed and semantically correct — it's just a redundant nesting that we don't auto-flatten.

**Polish (out of scope but noted):** When the user toggles root to `OR` and the tree has exactly one child that is an OR group, we COULD offer a one-click "Flatten this OR group into the root?" affordance. We're deferring this to a follow-up.

### Decision 7: Activity log

**Choice:** No new activity-log event kinds. The existing `query_table` / `scan_table` events already carry the compiled SQL or expression, which now reflects the chosen combinator naturally. The per-row Apply path emits the same event as the full Apply path (it's just a different `applied` state).

### Decision 8: Backend test coverage

**Choice:** Add Rust unit tests in `filter.rs` (or wherever the SQL compiler lives) for:
- OR-root with 2 simple children
- OR-root with 1 condition + 1 OR-group child
- AND-root unchanged (regression)
- Missing `combinator` field in JSON → defaults to AND (serde default test)

Frontend: extend `compileWhere.test.ts` and add cases to `treeMutations.test.ts`.

## Risks / Trade-offs

[`⌘F` collides with CodeMirror's built-in search] → The Raw WHERE editor and the SQL editor both ship CodeMirror with its default search panel bound to `⌘F`. Our window-level handler MUST detect a CodeMirror ancestor (`closest('.cm-editor')`) and bail without preventDefault, mirroring how the existing `⌘S` / `⌘1` handlers skip editable surfaces. Verified by manual QA on both modes.

[Inputs/selects steal `⌘F` if we don't preventDefault] → On macOS, `⌘F` inside a plain `<input>` does nothing by default (no native shortcut). Browsers running outside Tauri would open the page-find dialog, but Tauri's webview disables that. Still, we proactively `e.preventDefault()` when we handle the keystroke at the tab root so any future webview-policy change can't surprise us.

[Wire-format change to `FilterTree`] → Mitigated by `#[serde(default)]` on the Rust side and a write-after-default policy on the TS side. Forward roll: older Rust clients receive `combinator` from newer TS clients and accept it (serde happily ignores unknown fields if we use `#[serde(deny_unknown_fields = false)]`, which is the default). Backward roll: older TS clients send no `combinator`, Rust defaults to AND, behavior unchanged.

[Persisted settings carry `undefined` combinator forever for users who never touch the toggle] → Acceptable. The TS `getRootCombinator` helper resolves to AND. Users who DO toggle write the field, and it round-trips. No migration sweep is needed because there's no semantic regression.

[Single-row apply confuses users about which "Apply" is which] → Mitigated by:
- Distinct visual treatment: the per-row Apply is a small icon button (`▶` in violet, `aria-label="Apply only this row"`), the global Apply is the existing prominent button.
- A tooltip on the row button: `"Apply only this row (replaces active filter)"`.
- The global Apply's dirty pip stays accurate, so the user sees that the "applied" state diverged from "draft" after a single-row apply.

[Per-row Apply on an OR-group root child applies the full OR group as the only filter] → That's the intended semantics ("apply this row" = "apply this top-level entry"), but worth documenting explicitly in the spec scenario.

[Toggling combinator with a complex tree might change result set drastically] → Acceptable — that's the point. The dirty pip reflects the unsaved combinator change so the user knows they must hit `Apply` for it to take effect.

[Reduced motion] → The combinator toggle and the per-row Apply button MUST respect `prefers-reduced-motion`: hover transitions drop to 0ms. Already covered by the visual system; no additional work.

## Migration Plan

1. **Phase 1 — Types & Rust:** Add `combinator?: "AND" | "OR"` to `FilterTree` (TS) with `#[serde(default)]` on the Rust side. Ship and verify with the unchanged UI that existing trees keep compiling to `AND`-joined WHERE clauses.
2. **Phase 2 — Compile path:** Update `compileWhere.ts` and the Rust compiler to honor `combinator`. Add unit tests for OR-root. UI still doesn't expose the toggle.
3. **Phase 3 — Shared primitives:** Add `RootCombinatorToggle` and `RowApplyButton` to `src/modules/shared/filter-bar/`. Add unit/snapshot tests.
4. **Phase 4 — Postgres FilterBar wiring:** Wire the combinator toggle, per-row Apply, and `⌘F` handler in `FilterBar.tsx` + `TableViewerTab.tsx`. Update `useTableFilter` to round-trip the new field.
5. **Phase 5 — Dynamo QueryBuilder wiring:** Same for `QueryBuilder.tsx` + `DataViewTab.tsx` + `builderCompiler.ts`.
6. **Phase 6 — QA:** Manual cross-mode pass (Structured AND, Structured OR, OR-group child, Raw mode unaffected, per-row Apply, `⌘F` from grid focus, `⌘F` from CodeMirror focus = no-op).

**Rollback:** Each phase is independently revertable. If Phase 4 needs to roll back, the Rust + types changes (Phases 1-2) are forward-compatible — they remain dormant until UI exposes the toggle.

## Open Questions

- **Q1:** Should `⌘F` while the bar is already focused on a row jump to the FIRST row (i.e., a "go to top of filters" shortcut), or be a no-op? Proposal-leaning answer: yes, jump to first row's column picker (Decision 2, case 3). To confirm in implementation.
- **Q2:** Should the per-row Apply button show different iconography for an OR-group row (which applies an entire group) vs. a condition row? Proposal-leaning answer: same icon, tooltip text differs (`"Apply only this OR group"` vs. `"Apply only this row"`). To confirm.
- **Q3:** Do we want a third combinator value `"XOR"` someday? Not now, but worth noting that the enum is extensible if we ever need it.
