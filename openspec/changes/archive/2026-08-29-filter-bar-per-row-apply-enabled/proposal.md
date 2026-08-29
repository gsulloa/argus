## Why

Issue #289 (in-app feedback): pressing `Enter` inside a filter row whose checkbox is **off** paints the green **Applied** badge on that row while sending no filter at all to the query — and silently drops whatever filter was previously in force. Two halves of the filter bar were specified against each other: the per-row path deliberately ignores `enabled` (`onApplyOnlyRow` sets `applied = { rows: [row] }` without consulting `row.enabled`), while `modelToPayload` and `compileWhere` drop every non-`enabled` row. With a single disabled row in `applied.rows`, `modelToPayload` returns `{}` — no `filter_tree` — so the grid reloads **completely unfiltered** while the bar reports the opposite.

## What Changes

- **BREAKING (spec-level)** — per-row Apply (the row's `Apply` button and plain `Enter` inside a row) now **enables the row** as part of the gesture: it checks the row's box in `draft` and commits `{ rows: [enabledRow], combinator: draft.combinator }` to `applied`. This replaces the current "per-row Apply ignores checkbox state / MUST NOT modify `draft`" contract, which is what produces the silent no-op.
- Per-row Apply on an **incomplete** row (no column, unset operator, empty value, empty `In` list, half-filled `BETWEEN`, blank RAW expression) becomes an explicit **no-op** with inline transient feedback instead of wiping `applied` to an empty, unfilterable model.
- The **Applied** badge (and its green value-input tint) now additionally requires the draft row to be `enabled`, alongside the existing `isCompleteRow` gate. The badge can therefore only appear on rows whose predicate actually reached the query.
- `Shift+Enter` / `Apply All` / `⌘↵` / `⇧⌘↵` keep their current semantics (enabled + complete rows only, `draft` untouched apart from the combinator). This change is confined to the single-row path.
- Regression tests covering: Enter on an unchecked row, per-row Apply on an incomplete row, and badge suppression for an unchecked row.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `postgres-data-grid`: three requirements change.
  - **Filter row inclusion checkbox** — drop "The checkbox state MUST NOT affect per-row Apply"; per-row Apply now sets `enabled = true` on the target row.
  - **Per-row Apply and Applied visual state** — the Applied predicate gains an `enabled` clause; per-row Apply is redefined to mutate `draft` (enable the row) and to be a no-op on incomplete rows.
  - **Filter bar keyboard shortcuts** — the `Enter` row in the shortcut table and its two per-row scenarios are restated to match.

## Impact

- `packages/app/src/modules/postgres/data/TableViewerTab.tsx` — `onApplyOnlyRow` (~line 669).
- `packages/app/src/modules/postgres/data/filter-bar/FilterBar.tsx` — `buildAppliedSet` (~line 83) and the plain-`Enter` / row-button per-row dispatch (~lines 277, 459).
- `packages/app/src/modules/postgres/data/filter-bar/treeMutations.ts` — new pure helper for the enable-and-apply projection, so the behaviour is unit-testable without rendering the tab.
- Tests: `filter-bar/FilterBar.test.tsx`, `filter-bar/treeMutations.test.ts`.
- **Not affected**: `modelToPayload` / `compileWhere` (their `enabled` gate stays as-is — the fix restores the invariant they already assume), the backend, persistence shape (`FilterRow.enabled` already persists), and the MySQL / MSSQL filter bars (separate simpler components with no per-row Apply or Applied badge).
