## 1. Boolean value commits a concrete default

- [x] 1.1 In `packages/app/src/modules/postgres/data/filter-bar/ValueInput.tsx` (boolean branch, ~L144-159): when the category is `boolean` and the current model `value` is not already a boolean, eagerly commit `onChange(true)` (on first render of the boolean control) so the model matches the `<select>`'s displayed "true"; keep the rendered `<select value>` derived from the committed boolean (`String(value)`). — Extracted `BooleanValueInput` with a guarded `useEffect` that commits `true` when the value is not boolean.
- [x] 1.2 In `packages/app/src/modules/postgres/data/filter-bar/treeMutations.ts` (`coerceValueForOperator`, ~L74-93) and/or the column-change handler: when a row's column resolves to a boolean type, seed/preserve a concrete boolean value (default `true`) instead of `""`, covering the "switch an existing row's column to a boolean column" path. — Seeded in `ConditionRow.onColumnChange` (knows the target column's data type) for immediacy; the value-input effect is the fallback.
- [x] 1.3 Confirm the empty-row default path (`EMPTY_FILTER_ROW_FIELDS` in `packages/app/src/modules/postgres/data/types.ts`, ~L115) does not force a non-boolean placeholder that overrides 1.1/1.2 once a boolean column is selected. — Left `EMPTY_FILTER_ROW_FIELDS` unchanged; the empty `""` placeholder is superseded by the seeding in 1.1/1.2 once a boolean column is picked.

## 2. Completeness accepts boolean values

- [x] 2.1 In `packages/app/src/modules/postgres/data/types.ts` `isCompleteRow` (~L302): accept `value === true || value === false` as complete BEFORE the `value === "" | null | undefined` rejection, so `= false` rows are not dropped.
- [x] 2.2 Verify `modelToPayload` (~L253-269) now emits a `filter_tree` containing the boolean condition for a `boolean = true` / `= false` row (no longer returns `{}`). — Covered by new unit tests in `filterRowEquals.test.ts`.

## 3. Applied badge reflects actual application

- [x] 3.1 In `packages/app/src/modules/postgres/data/filter-bar/FilterBar.tsx` `buildAppliedSet` (~L75-90) and/or the per-row badge derivation: gate the "Applied" (green) state on the draft row being complete — an incomplete row must render the neutral `Apply` state even when its `(column, op, value)` triple matches a row in `applied`. — Added `if (!isCompleteRow(dr)) continue;` in `buildAppliedSet`.
- [x] 3.2 Keep `filterRowEquals` (`types.ts` ~L310-314) semantics for equality, but ensure the completeness gate is applied where the badge is computed. — `filterRowEquals` unchanged; gate lives in `buildAppliedSet`.

## 4. Tests

- [x] 4.1 Unit test: a boolean row left at its default is complete and `modelToPayload` emits `{ column: named "email_verified", op: "=", value: true }`. — `filterRowEquals.test.ts` "modelToPayload — boolean rows".
- [x] 4.2 Unit test: `isCompleteRow` returns `true` for a boolean row with `value: false`; `modelToPayload` emits the `= false` condition. — `filterRowEquals.test.ts` "isCompleteRow — boolean values" + "modelToPayload — boolean rows".
- [x] 4.3 Unit test / component test: the per-row badge shows neutral `Apply` (not green `Applied`) for an incomplete row whose triple matches an `applied` row. — `FilterBar.test.tsx` "does NOT show the green Applied badge for an incomplete row…".
- [x] 4.4 Component test: adding `email_verified = true` and applying issues a `postgres.queryTable` call whose `filter_tree` carries the boolean condition (regression for the missing `WHERE` clause). — `FilterBar.test.tsx` "a freshly-picked boolean row commits value true and yields a filter_tree carrying the boolean condition" (asserts the committed draft → `modelToPayload` carries the boolean condition; this is the payload that `postgres.queryTable` receives).

## 5. Verify end-to-end

- [ ] 5.1 Run the app against a Postgres table with a boolean column: add `<bool col> = true`, Apply, and confirm the activity-log SQL contains the `WHERE ... = $1` clause and rows are correctly filtered (no `false` rows appear). — PENDING manual QA: requires the running desktop app + a live Postgres connection (cannot be exercised headlessly here). The automated regression in 4.4 verifies the payload that produces the `WHERE` clause.
- [ ] 5.2 Repeat with `= false` and confirm the inverse subset; confirm the badge no longer shows green for an incomplete/blank row. — PENDING manual QA (same reason as 5.1).
