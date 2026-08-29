## Context

The Postgres filter bar keeps two models per table tab: `draft` (what the form shows) and `applied` (what the query runs). Three pieces of today's code encode mutually inconsistent rules about the `enabled` checkbox:

| Site | Rule |
|---|---|
| `TableViewerTab.onApplyOnlyRow` (`TableViewerTab.tsx:669`) | `setApplied({ rows: [draft.rows[index]], … })` — never reads `row.enabled` |
| `modelToPayload` (`data/types.ts:273`) | `model.rows.filter(r => r.enabled).filter(isCompleteRow)`; empty → returns `{}` (**no `filter_tree`**) |
| `compileWhere` (`filter-bar/compileWhere.ts:37`) | same `enabled` + `isCompleteRow` gate, for the SQL footer |
| `buildAppliedSet` (`filter-bar/FilterBar.tsx:83`) | matches on `(column, op, value)` via `filterRowEquals`, gated on `isCompleteRow(draftRow)` only — `enabled` deliberately ignored |

The consumers (`modelToPayload`, `compileWhere`) assume the invariant **`applied.rows` only ever holds enabled + complete rows**. `onApplyFilters` (Apply All) upholds it. `onApplyOnlyRow` violates it, and `buildAppliedSet` then reports the violated state as success. Net effect of issue #289: `Enter` on an unchecked row → `applied = [disabledRow]` → payload `{}` → a fully unfiltered refetch, with the green **Applied** badge on the row that caused it.

The same shape of violation exists for **incomplete** rows: `onApplyOnlyRow` will happily commit `[incompleteRow]`, which `modelToPayload` also drops to `{}`. There the badge does not lie (`buildAppliedSet` already gates on `isCompleteRow`), but the silent wipe of the previously applied filter is identical, so it is fixed in the same pass.

Nothing here touches the backend: `enabled` is a client-only flag never sent on the wire.

## Goals / Non-Goals

**Goals:**

- Per-row Apply (row `Apply` button and plain `Enter` inside a row) always results in that row's predicate actually reaching the query, or in nothing happening at all — never in a silent unfiltered refetch.
- The **Applied** badge and green value tint appear only on draft rows whose predicate is in force.
- Restore and preserve the invariant `applied.rows ⊆ { enabled ∧ complete }` at every write site.
- Keep the fix testable without rendering `TableViewerTab` (a large component with data hooks and Tauri IPC).

**Non-Goals:**

- Changing `Apply All` / `⇧↵` / `⌘↵` / `⇧⌘↵` semantics.
- Changing `modelToPayload`, `compileWhere`, the wire shape, or the backend.
- Changing filter persistence (`useTableFilter` already persists `enabled` per row).
- Touching the MySQL / MSSQL filter bars (`modules/mysql/data/FilterBar.tsx`, `modules/mssql/data/FilterBar.tsx`) — separate, simpler components with a single bar-level `Apply` and no per-row Applied badge.
- Introducing a disabled state on the per-row `Apply` button.

## Decisions

### Decision 1 — Per-row Apply **enables** the row (rather than bypassing the `enabled` gate)

Issue #289 offers two ways out: (A) implicitly check the row's box, or (B) let the per-row path bypass the `enabled` gate. **Choose A.**

- A keeps a single, global rule — *only enabled+complete rows filter* — honoured by every write site. B would require a second notion of "applied but not enabled" threaded through `modelToPayload`, `compileWhere`, and the SQL-footer preview, and would leave an unchecked box visibly driving the result set.
- A gives free, correct on-screen feedback: the checkbox visibly turns on, so the **Applied** badge, the checkbox, the value tint, and the grid all agree without any extra UI.
- A is trivially reversible (uncheck the box) and non-destructive to the rest of `draft`.
- Cost: it breaks the current spec sentence "the per-row Apply button MUST NOT modify `draft`". That sentence is the bug's spec-level root, so amending it is the point of the change, not collateral damage.

`draft.combinator` is still never modified by the per-row path.

### Decision 2 — Model the projection as a pure helper in `treeMutations.ts`

Add to `filter-bar/treeMutations.ts`:

```ts
/**
 * Project the per-row Apply gesture. Returns the next `draft` (with row
 * `index` enabled) and the single-row `applied` model, or `null` when the
 * row is missing or incomplete — the caller must then leave both models
 * alone rather than commit an empty, unfilterable `applied`.
 */
export function applyOnlyRowModels(
  draft: FilterTree,
  index: number,
): { draft: FilterTree; applied: FilterTree } | null
```

Implementation: bail to `null` on a missing row or `!isCompleteRow(row)`; otherwise `const enabledRow = row.enabled ? row : { ...row, enabled: true }` and return `{ draft: setEnabled(draft, index, true), applied: { rows: [enabledRow], combinator: draft.combinator } }`. When the row is already enabled, `setEnabled` short-circuits through `setRow`, so identity churn stays minimal.

The `enabledRow` value is built locally rather than read back from the next `draft` because `setDraft` is async React state — `applied` must be written in the same tick from the same value.

Rationale: `TableViewerTab.tsx` has no unit-test harness (it pulls in data hooks and Tauri IPC), while `treeMutations.test.ts` already exists and covers `setEnabled` / `setRow` / `moveRow`. Putting the decision in a pure function makes every branch of #289 assertable directly. `onApplyOnlyRow` shrinks to: call the helper, `return` on `null`, otherwise `setDraft` + `setApplied` + bump `applyToken`.

Alternative rejected: enabling the row inside `FilterBar` via `onDraftChange` before calling `onApplyOnlyRow`. That splits one gesture into two renders and races the `applied` write against the `draft` write — `onApplyOnlyRow` would still read the stale `draft` prop and commit the disabled row.

### Decision 3 — Incomplete rows are a no-op with transient inline feedback, not a disabled button

The completeness check lands in two places, by design:

- `FilterBar.handleApplyOnlyRow(i)` — shared by the plain-`Enter` handler and the row's `Apply` button. On an incomplete row it shows the existing transient inline status (`"Row is incomplete"`, same 2s `setTransientStatus` mechanism as `"No filters enabled"`) and does **not** call `onApplyOnlyRow`. This is the user-visible half: silence on Enter would read as another broken gesture.
- `applyOnlyRowModels` returning `null` — the invariant guard, so no future caller can commit an unfilterable `applied` even if it skips the UI layer.

Rejected: disabling the row's `Apply` button while incomplete. It removes the affordance exactly when a user is most likely to reach for it, and gives no explanation.

### Decision 4 — `buildAppliedSet` gains an `enabled` clause

`buildAppliedSet` becomes: skip a draft row unless `dr.enabled && isCompleteRow(dr)`, then match `filterRowEquals` against `applied.rows` as today. Deliberately **not** switched to `filterRowEqualsWithEnabled` — `applied.rows` entries are now always `enabled: true` by construction, so comparing the flag on both sides is redundant, and gating on the *draft* row's flag is what mirrors the existing `isCompleteRow(dr)` gate.

Consequence worth naming: apply a row, then uncheck it. The badge drops immediately while the query is still filtered by that row until the next apply. This is intended and consistent with the bar's existing model — the badge describes the draft row's current configuration, exactly as the `isCompleteRow(dr)` gate already does, and the bar's dirty indicator (`filterModelEquals`, which compares `enabled` via `filterRowEqualsWithEnabled`) is what signals "the form no longer matches the query".

After Decision 1 this clause is unreachable via the per-row path itself; it exists so the badge can never re-acquire the meaning it had in #289.

## Risks / Trade-offs

- **Per-row Apply now mutates `draft`, contradicting the shipped spec and its tests** → The spec delta rewrites the three affected requirements verbatim-with-edits; the two existing scenarios that assert the old contract (`Per-row Apply ignores checkbox state`, `Plain Enter applies the focused row even when its checkbox is unchecked`) are rewritten in the same delta, and `FilterBar.test.tsx:679` (`plain Enter … does not modify draft`-adjacent assertions) is updated in the same commit rather than left to fail.
- **Muscle memory: a user who deliberately unchecked a row and hits Enter on it now gets it checked** → One click to undo, the checkbox change is visible, and the alternative today is a wiped filter set — strictly worse. Apply All continues to respect the unchecked state.
- **Badge disappears while the row is still filtering (uncheck-after-apply)** → Accepted; the dirty indicator already covers "form ≠ query", and the inverse (badge shown for a row contributing nothing) is the bug being fixed.
- **A user relying on Enter to "clear filters by applying an empty row"** → That path was never intentional; the footer `Unset` button (`onUnsetFilters`) is the supported way to stop filtering and is unchanged.

## Migration Plan

Pure client-side behaviour change in the Postgres data viewer. No persisted-state migration (`FilterRow.enabled` already exists in the stored model and keeps its meaning), no wire or backend change, no feature flag. Rollback is a revert of the commit.

## Open Questions

None.
