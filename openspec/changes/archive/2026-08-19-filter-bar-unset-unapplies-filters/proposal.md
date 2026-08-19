## Why

Issue #278 asked that the Postgres filter bar's `Operator: Unset` control *"no borre
los filtros, solo que los deseleccione"*. The shipped fix (PR #283, v0.8.6) read
"deseleccionar" as **deselect the operator**: `Unset` now nulls `op` on every draft
row, so the operator dropdowns all fall back to the `—` placeholder and the rows go
inert until the user re-picks an operator one by one.

That is not what was asked for. The intent is **deselect the filters, not the
operators**: the filter form should stay exactly as the user built it — columns,
operators, values, checkboxes, order — and simply stop being applied to the grid.
Today the only way to get "same form, no filtering" is to null every operator
(destroying the operator choices) or to uncheck every row and press `Apply All`
(mutating the form). Restoring the previous filtering then means re-selecting an
operator on every row by hand.

## What Changes

- **BREAKING (behavioural, reverts part of #283)** The footer `Unset` control no
  longer touches `draft` at all. Activating it clears the **applied** filter:
  `applied.rows` becomes `[]` and the grid refetches unfiltered. `draft` — every
  row's `column`, `op`, `value`, `enabled`, `id`, order, and `draft.combinator` —
  is left byte-for-byte unchanged, so the form on screen is identical before and
  after the click, just no longer in force.
- Re-applying is a single gesture: `Apply All` (or per-row `Apply`) puts the
  untouched form back in force. No operator has to be re-picked.
- Because `Unset` now commits to `applied`, it participates in the existing
  "Filter Apply always refetches" contract — it advances the apply token and
  always issues a fresh query, even when `applied` was already empty.
- The footer label changes from `Operator: [Unset]` to `Filters: [Unset]`; the
  prefix no longer lies about the scope, and the tooltip becomes "Stop applying the
  filters — the filter form is kept as is". Position in the footer strip is
  unchanged (far end, still not adjacent to `Clear all`).
- `unsetAllOperators` in `treeMutations.ts` loses its only caller and is removed.
- The **null-operator row state is retained but no longer producible from the UI**.
  v0.8.6 shipped `Unset` writing `op: null` into the persisted `pgTableFilter:*`
  record, so `FilterRow.op: Operator | null`, `isCompleteRow`'s null guard,
  `OperatorPicker`'s `—` placeholder, `ValueInput`'s shape-derived control, and
  `migrateLegacyFilterModel`'s null tolerance all stay in place. Without them a
  v0.8.6 user who clicked `Unset` would have their whole persisted filter discarded
  on upgrade. Nothing in the app creates a null operator any more.
- `Clear all` is unchanged: it still resets `draft.rows` to one empty row and still
  leaves `applied` alone.
- The bottom bar's filter chip `✕` is unchanged: it still resets **both** halves
  (`draft` and `applied`) via `resetFilter()`. `Unset` is deliberately the weaker,
  draft-preserving sibling of that action.

Non-goals: MySQL, MSSQL, DynamoDB, Athena and CloudWatch filter surfaces. None of
them render an `Unset` control. No Rust/IPC change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `postgres-data-grid`:
  - "Filter bar footer Unset, Clear all, Export, SQL" — the `Unset` bullet is
    rewritten from operator-scoped (`draft`) to filter-scoped (`applied`), the
    label becomes `Filters: [Unset]`, and its scenarios are replaced.
  - "Filter draft and applied state" — `Unset` moves from the "neither touches
    `applied`" sentence to the list of commits to `applied`; the `Unset does not
    delete rows` scenario is restated in terms of the new behaviour.
  - "Unset operator row state" — reframed (same requirement name) as a **legacy-compatibility**
    requirement: the null-operator state must still round-trip through persistence
    and render recoverably, but no UI affordance may produce it.
  - "Filter Apply always refetches" — `Unset` is added to the enumerated commit
    gestures that MUST refetch.

## Impact

Frontend only; no Rust/IPC change (the wire payload was already free of the unset
state).

- `packages/app/src/modules/postgres/data/filter-bar/FilterBar.tsx` — `handleUnset`
  becomes a new `onUnsetFilters` prop call; footer label/tooltip copy.
- `packages/app/src/modules/postgres/data/TableViewerTab.tsx` — new
  `onUnsetFilters` handler (`setApplied({ rows: [], combinator: draft.combinator })`
  + apply-token bump), wired to `<FilterBar onUnsetFilters={…} />`.
- `packages/app/src/modules/postgres/data/filter-bar/treeMutations.ts` — remove
  `unsetAllOperators`.
- Unchanged but load-bearing for legacy records: `types.ts` (`op: Operator | null`,
  `isCompleteRow`), `OperatorPicker.tsx`, `ValueInput.tsx`, `compileWhere.ts`,
  `migrateLegacyFilterModel.ts`.
- Tests: `FilterBar.test.tsx`, `treeMutations.test.ts`, `TableViewerTab.test.tsx`.
- CHANGELOG: an `Unreleased → Changed` entry correcting the v0.8.6 note, since the
  behaviour users read about in 0.8.6 is being replaced.
- Persistence: no schema change. Records written by v0.8.6 that contain `op: null`
  still load and still render as recoverable unset rows.
