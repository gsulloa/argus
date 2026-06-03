## Context

GitHub issue #53 reports that plain `Enter` inside a filter value input does nothing across all engines, so users must click the Apply / Run button. The current state per engine:

| Engine | Plain Enter | ⌘↩ |
|---|---|---|
| MySQL | ❌ | ❌ |
| MSSQL | ❌ | ❌ |
| Postgres | ❌ | ✅ (⌘↩ = AND, ⇧⌘↩ = OR) |
| Dynamo | ❌ | N/A (uses tab-level ⌘R) |

The four implementations live in independent files (no shared `FilterBar` base):
- `src/modules/mysql/data/FilterBar.tsx:246–254` — plain `<input>` with `onChange` only.
- `src/modules/mssql/data/FilterBar.tsx:243–251` — same.
- `src/modules/postgres/data/filter-bar/FilterBar.tsx:183–218` — bar-root `onKeyDown` that handles ⌘↩ / ⇧⌘↩ today; plain Enter not handled.
- `src/modules/postgres/data/filter-bar/ValueInput.tsx:130–179` — `ChipInput` for `In`/`NotIn` already binds Enter to commit a chip (must not break).
- `src/modules/dynamo/data-view/QueryBuilder.tsx` — filter rows render typed value editors; `handleRun()` exists, no per-row keydown.

There is no shared "value-input wrapper" component across engines — each engine renders its own `<input>` for filter values. We can either add four near-identical handlers (one per engine) or introduce a small shared helper. Given the four FilterBars already diverge in non-trivial ways (chip input, BETWEEN, case-insensitive toggle, typed values), per-engine duplication is the lower-risk path.

## Goals / Non-Goals

**Goals:**
- Plain `Enter` in any filter value input triggers Apply / Run on all four engines.
- Postgres keeps `⌘↩` / `⇧⌘↩` working with AND/OR-forcing semantics; plain `Enter` uses the current persisted combinator without modifying it.
- Postgres `ChipInput` (In/NotIn) keeps committing chips on Enter; chip commit MUST NOT bubble to Apply All.
- No regression to existing focus management, `⌘F` toggle, or `Esc` handling.

**Non-Goals:**
- Refactoring the four FilterBar implementations into a shared component. (Out of scope; only the keydown affordance is in this change.)
- Adding Enter-to-apply when focus is in non-value controls (column picker, operator picker, checkboxes) — those are dropdown / form controls with their own semantics.
- CloudWatch Logs has no filter bar with value inputs and is unaffected.
- Touching `⌘R` on Dynamo (already tab-level; unchanged).

## Decisions

### D1. Per-engine implementation, not a shared component

Each FilterBar already implements its own keyboard, focus, and value-input concerns differently (Postgres has a root-level handler with focus tracking; MySQL/MSSQL have none; Dynamo uses typed editors). Adding a shared `useFilterEnterToApply` hook would force unification of unrelated decisions. We add the handler at the appropriate layer per engine.

**Alternatives considered:**
- Shared hook `useApplyOnEnter(ref, onApply)` — adds an abstraction for ~4 lines per call site; rejected as YAGNI.
- Promote `<FilterValueInput>` shared component — too large for this scope.

### D2. Postgres: extend the existing root `onKeyDown`, do NOT add per-input handlers

`FilterBar.tsx:183–218` already handles bar-level keys at the root `<div>`. We extend the same branch to handle plain `Enter` (no meta) inside the bar.

**Logic** (added before the existing `if (!meta) return;` early-out):

```ts
// Plain Enter → Apply All with the current persisted combinator.
if (e.key === "Enter" && !meta && !e.shiftKey && !e.altKey) {
  // Skip when focus is in CodeMirror (already handled by existing guard).
  // Skip when focus is in a ChipInput draft input with non-empty value
  // (ChipInput's own onKeyDown commits the chip and calls preventDefault +
  //  stopPropagation, so this path is normally unreachable, but we guard
  //  defensively against future regressions).
  const active = document.activeElement as HTMLElement | null;
  if (active?.dataset.chipInput === "true" && (active as HTMLInputElement).value !== "") {
    return; // let ChipInput handle it
  }
  e.preventDefault();
  handleApplyAll(); // does NOT touch draft.combinator
  return;
}
```

We also harden `ChipInput` (`ValueInput.tsx`) so its Enter handler:
- calls `e.stopPropagation()` after `e.preventDefault()`, AND
- tags its `<input>` with `data-chip-input="true"` so the bar-root handler can deterministically detect "focus is in ChipInput with non-empty draft" without prop drilling.

The existing ⌘↩ / ⇧⌘↩ branches stay intact and continue to force `AND` / `OR`.

**Alternatives considered:**
- Per-input `onKeyDown` on every scalar value input in `ValueInput.tsx` — would touch many sites (text, number, date) and duplicate the focus-scope logic already at the root. Rejected.

### D3. MySQL / MSSQL: per-input `onKeyDown` (no bar-level handler exists)

Neither MySQL nor MSSQL has a root keydown handler today. Adding one would change focus semantics broadly. Instead, we attach `onKeyDown` directly on each value `<input>` (there are at most 1–2 per row including the BETWEEN min/max case):

```tsx
<input
  type="text"
  value={displayValue as string}
  onChange={handleValueChange}
  onKeyDown={(e) => {
    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      onApply();
    }
  }}
  ...
/>
```

`onApply` is already a prop on the row component and triggers Apply All at the parent (`TableViewerTab`).

**For BETWEEN** (MySQL/MSSQL render "min,max" as a single text input — no min/max split here per current implementation), one onKeyDown is sufficient.

### D4. Dynamo: per-input `onKeyDown` on text / number value editors

`QueryBuilder.tsx` renders typed value editors per filter row. We attach `onKeyDown` to the text and number editors (skip the boolean toggle and unary operators that have no editor). The handler calls `handleRun()` which is already in scope at the row level via a `onRun` prop / closure.

```tsx
onKeyDown={(e) => {
  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    handleRun();
  }
}}
```

Partition-key and sort-key inputs already participate in `⌘R` at the tab level; we do NOT add a plain-Enter handler there to avoid double-runs (`handleRun()` could fire twice if Enter bubbled). The spec scenario explicitly excludes those.

### D5. No combinator mutation on plain Enter (Postgres)

`⌘↩` forces `AND`; `⇧⌘↩` forces `OR`. Plain `Enter` is intentionally different: it acts as "click the primary Apply All button," which uses `draft.combinator` as-is. This preserves the user's persisted choice (`filter_root_combinator` per-table setting) — typing a value and pressing Enter should not silently reset their `OR` preference back to `AND`.

## Risks / Trade-offs

- **[Risk]** Postgres `ChipInput` Enter currently commits a chip; if our new bar-root handler runs first, the chip is lost. → **Mitigation**: `ChipInput`'s onKeyDown already calls `e.preventDefault()` (line 168). We add `e.stopPropagation()` in the same handler so the event never reaches the bar root. We also add a defensive `data-chip-input` check at the root as a belt-and-suspenders measure.

- **[Risk]** Enter on a column-picker or operator-picker dropdown could now trigger Apply All if those dropdowns let Enter bubble. → **Mitigation**: The native `<select>`/dropdown components already consume Enter for their own selection. We add the handler at the bar root, which fires only when no inner handler called `stopPropagation`. We'll smoke-test column picker + operator picker after the change.

- **[Risk]** MySQL/MSSQL spec already declared `⌘↩` works; the source code shows it doesn't. → This is a pre-existing spec/code drift. This change doesn't fix `⌘↩` for MySQL/MSSQL — it only adds plain Enter. We note the gap in the spec but don't expand scope to a separate bug.

- **[Trade-off]** Per-input `onKeyDown` on MySQL/MSSQL/Dynamo is repetitive (3 nearly-identical handlers). Accepted because the FilterBars already diverge significantly and a shared helper would be a larger refactor.

- **[Risk]** Dynamo BETWEEN renders two inputs (min, max). Plain Enter from `min` would run before the user types `max`. → **Acceptable**: the builder's existing validation will display an inline error and disable the Run button when the row is incomplete; `handleRun()` is a no-op when the builder is invalid. No regression.

## Migration Plan

- No data, schema, or settings migration. No persisted state added.
- Ship as a single PR. No feature flag — the change is additive and low-risk.
- Rollback: revert the PR. Existing ⌘↩ / Apply button / Run button behaviour is untouched.

## Open Questions

None — proposal, specs, and design are aligned. Proceed to tasks.
