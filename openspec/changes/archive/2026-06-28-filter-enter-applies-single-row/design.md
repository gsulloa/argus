## Context

The Postgres filter bar (`packages/app/src/modules/postgres/data/filter-bar/FilterBar.tsx`) is a `forwardRef` component driven by a `draft` / `applied` `FilterTree` pair owned by `TableViewerTab`. Two commit paths already exist in the parent:

- `onApplyFilters()` (`TableViewerTab.tsx:629`) — Apply All: `setApplied({ rows: draft.rows.filter(enabled && complete), combinator: draft.combinator })`.
- `onApplyOnlyRow(index)` (`TableViewerTab.tsx:636`) — per-row: `setApplied({ rows: [draft.rows[index]], combinator: draft.combinator })`, regardless of the row's `enabled` flag.

Both bump an `applyToken` so the grid always refetches (per "Filter Apply always refetches").

Today the keydown handler (`FilterBar.tsx:183-327`) wires plain `Enter` (`!meta && !shift && !alt`) to `handleApplyAll()`. The per-row `Apply` button (`ConditionRow` → `onApplyOnly` → `onApplyOnlyRow`) is the only way to apply a single row, and it is mouse-only. `Shift+Enter` alone is currently unhandled. The footer renders a `FilterKeyHint` strip that lists `Apply All: ⌘↵` but does not mention `Enter`.

The bug (#198): a user types a new filter into a row whose `enabled` checkbox is off and presses `Enter`; `handleApplyAll` filters that row out (it's not `enabled`), so the previously-applied filter persists and the new one is silently dropped.

The decision (confirmed with the user) is to make plain `Enter` behave exactly like the per-row `Apply` button — apply only the focused row, replacing the active filter — and move Apply-All to `Shift+Enter`. The `enabled` checkbox stays a pure gate for Apply-All; `Enter` does not toggle it.

## Goals / Non-Goals

**Goals:**
- Plain `Enter` inside the bar applies only the focused row (replace `applied` with `[focusedRow]`), independent of that row's `enabled` checkbox — reusing the existing `onApplyOnlyRow` path.
- `Shift+Enter` performs Apply All using the current `draft.combinator`.
- Preserve `⌘↵` (Apply All AND) and `⇧⌘↵` (Apply All OR) exactly as-is.
- Preserve the `In`/`NotIn` chip-input `Enter` exception for both plain `Enter` and `Shift+Enter`.
- Make the new shortcuts discoverable via the footer hint strip (and optionally the per-row Apply tooltip).

**Non-Goals:**
- No changes to MySQL/MSSQL filter bars (separate components — possible follow-up).
- No change to `enabled`-checkbox semantics beyond confirming Enter does not touch it.
- No backend, wire-contract, `types.ts`, or `treeMutations.ts` changes.
- No new "apply-and-accumulate / merge into applied" behavior — `Enter` *replaces* with the single row, matching the per-row Apply button.

## Decisions

### D1: Reuse `onApplyOnlyRow(index)` for plain Enter — resolve the focused row from the DOM

The keydown handler already resolves a focused row index for `⌘I` / `⌘⇧I` / `⌘↑` / `⌘↓` / `⌘←` via `document.activeElement.closest("[data-filter-row-index]")` and `parseInt(dataset.filterRowIndex)`. The plain-`Enter` branch will use the same pattern: resolve `idx`; if `idx >= 0`, call `onApplyOnlyRow(idx)`; otherwise fall back to `handleApplyAll()`.

- **Why:** `onApplyOnlyRow` already implements the exact required semantics (`applied = { rows: [thatRow], combinator }`, ignores `enabled`, bumps the refetch token). No new prop or parent handler is needed.
- **Fallback rationale:** focus can be inside the bar but not inside a row (e.g. a footer button). Rather than swallow the keystroke, falling back to Apply All preserves a sensible "commit" gesture. This is an edge case; in normal use Enter is pressed while editing a row's value/operator/column, all of which live under `[data-filter-row-index]`.
- **Alternative considered — add a new `onApplyEnter` prop / accumulate-into-applied:** rejected. The user explicitly chose replace-semantics identical to the existing per-row Apply button, so introducing a third commit path would add surface area for no behavioral gain.

### D2: `Shift+Enter` → `handleApplyAll()` (current combinator, no AND/OR forcing)

Add a branch in the no-meta section: `e.key === "Enter" && e.shiftKey && !e.altKey` → guard chip input, `preventDefault()`, `handleApplyAll()`. This is the behavior plain `Enter` had before, so `handleApplyAll`'s existing "No filters enabled" transient-status feedback is retained for free.

- **Why current combinator (not AND):** matches the prior plain-Enter behavior and keeps `⌘↵`/`⇧⌘↵` as the explicit AND/OR forcing shortcuts. The combinator is set elsewhere (chevron menu / ⌘ shortcuts); Shift+Enter should not silently change it.

### D3: Chip-input exception applies to both Enter variants

The existing guard checks `active.dataset.chipInput === "true" && value !== ""` and returns early so the chip input commits the chip. This guard must run for both the plain-`Enter` and `Shift+Enter` branches. Implementation: compute the chip-input early-return once at the top of the combined Enter handling (before splitting on `shiftKey`), so a non-empty chip draft suppresses both apply paths.

### D4: Branch ordering in `onKeyDown`

The plain-Enter and Shift+Enter branches both live in the **no-meta** region (before the `if (!meta) return;` guard at `FilterBar.tsx:204`). The existing `⌘↵` / `⇧⌘↵` branches live after that guard and are untouched. New structure for the no-meta Enter handling:

```
if (e.key === "Enter" && !meta && !e.altKey) {
  // chip-input guard (shared) — return early if committing a chip
  e.preventDefault();
  if (e.shiftKey) { handleApplyAll(); return; }
  // plain Enter: resolve focused row, apply only it
  const idx = resolveFocusedRowIndex();   // closest [data-filter-row-index]
  if (idx >= 0) onApplyOnlyRow(idx); else handleApplyAll();
  return;
}
```

The `onKeyDown` `useCallback` dependency array gains `onApplyOnlyRow` (already a stable prop from the parent).

### D5: Documentation — footer hint strip + tooltip

Update the footer `FilterKeyHint` strip to add `Apply row: ↵` and `Apply All: ⇧↵` (keeping `⌘↵` discoverable via the Apply All button's dropdown menu, which already shows `⌘↵` / `⇧⌘↵`). Optionally refine `RowApplyButton`'s tooltip to mention `Enter`. The strip is purely presentational (`FilterKeyHint` is non-interactive) so this is low-risk copy.

## Risks / Trade-offs

- **[Behavior change is muscle-memory-breaking]** Users who learned that plain `Enter` = Apply All will now apply only the focused row. → Mitigated by the explicit footer hints and by the fact that the new behavior matches TablePlus (the reference the user cited) and is the requested change.
- **[Focused-row resolution returns -1]** If `Enter` is pressed while focus is on a footer control inside the bar, `onApplyOnlyRow` would be wrong. → Mitigated by the `idx >= 0` guard falling back to `handleApplyAll()`; footer buttons are not normal Enter targets.
- **[Incomplete focused row]** `onApplyOnlyRow` does not check `isCompleteRow`; pressing Enter on a half-typed row applies `[incompleteRow]`, which `modelToPayload` drops to an empty filter (grid unfilters). → Accepted: this is identical to the existing per-row Apply button behavior; keeping parity avoids a surprising divergence between the button and the key.
- **[Test churn]** No existing test asserts plain-Enter→ApplyAll (confirmed via grep), so no test is invalidated; only additions/clarifications are needed. → Low risk.

## Migration Plan

Pure frontend, no data migration. Ship in the normal release; no feature flag. Rollback is a straight revert of the `FilterBar.tsx` (and test) diff.

## Open Questions

None — the Enter/Shift+Enter semantics and checkbox behavior were confirmed with the user before this design.
