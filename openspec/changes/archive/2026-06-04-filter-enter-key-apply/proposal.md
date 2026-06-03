## Why

Users report that pressing **Enter** inside a filter value input in the data grid does nothing — they must click the Apply / Run button to run the query (GitHub issue #53). Only Postgres handles ⌘↩ today; plain Enter is unhandled across every engine. This breaks a baseline keyboard expectation for any "type a value, hit Enter to apply" form and slows down day-to-day filter editing.

## What Changes

- **MySQL data grid**: plain **Enter** in any filter row value input applies the active filter set (calls `onApply()`).
- **MSSQL data grid**: plain **Enter** in any filter row value input applies the active filter set (calls `onApply()`).
- **Postgres data grid**: extend the existing keyboard handler so plain **Enter** (no modifier) also runs `handleApplyAll()` with the current combinator (do **not** force the combinator to AND like ⌘↩ does). ⌘↩ / ⇧⌘↩ retain their current AND/OR-forcing behaviour.
- **Dynamo data view**: plain **Enter** in any filter row value input triggers `handleRun()`.
- **Postgres `ChipInput` (In / NotIn operators)** keeps its existing Enter-commits-chip behaviour; plain Enter only applies filters when no chip draft is being committed. Enter in a ChipInput with an in-progress draft commits the chip and does **not** propagate to apply.

## Capabilities

### New Capabilities

(none — this is a refinement of existing data-grid filter behaviour)

### Modified Capabilities

- `postgres-data-grid`: plain Enter inside the filter bar applies all enabled filters using the current combinator.
- `mysql-data-grid`: plain Enter inside a filter value input applies all filters.
- `mssql-data-grid`: plain Enter inside a filter value input applies all filters.
- `dynamo-data-view`: plain Enter inside a filter value input runs the query.

## Impact

- Code affected:
  - `src/modules/mysql/data/FilterBar.tsx` — add `onKeyDown` on the value `<input>`.
  - `src/modules/mssql/data/FilterBar.tsx` — add `onKeyDown` on the value `<input>`.
  - `src/modules/postgres/data/filter-bar/FilterBar.tsx` — extend root `onKeyDown` to handle plain Enter (no meta).
  - `src/modules/postgres/data/filter-bar/ValueInput.tsx` — ensure ChipInput's Enter handler calls `stopPropagation` (or equivalent) so it never bubbles to the root apply.
  - `src/modules/dynamo/data-view/QueryBuilder.tsx` — add `onKeyDown` on value editors (text/number; skip Boolean toggle).
- No API, schema, or persistence changes. No new dependencies.
- Accessibility: improves keyboard-only navigation. No regression to existing ⌘↩ / ⇧⌘↩ shortcuts in Postgres.
