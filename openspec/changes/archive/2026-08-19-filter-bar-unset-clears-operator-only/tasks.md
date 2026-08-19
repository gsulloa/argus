## 1. Widen the filter model

- [x] 1.1 In `packages/app/src/modules/postgres/data/types.ts`, change `FilterRow.op` to `Operator | null` and add `export type CompleteFilterRow = FilterRow & { op: Operator }`. Leave the `Operator` union and `WireCondition` untouched.
- [x] 1.2 Convert `isCompleteRow` to a type predicate — `export function isCompleteRow(row: FilterRow): row is CompleteFilterRow` — and make `if (row.op === null) return false;` its first check (before the `column` checks, so an unset row is rejected regardless of column state).
- [x] 1.3 Verify `filterRowEquals` still behaves with `null` ops (`a.op !== b.op` already covers `null === null` and `null !== "="`); add no special case.
- [x] 1.4 Verify `modelToPayload` narrows via `isCompleteRow` so `op` is `Operator` in the emitted `WireCondition` with no cast. Adjust the filter callback if TS cannot narrow through the `r.enabled && isCompleteRow(r)` conjunction (split into `.filter((r) => r.enabled).filter(isCompleteRow)` if needed).
- [x] 1.5 `EMPTY_FILTER_ROW_FIELDS` / `makeEmptyRow()` keep `op: "Contains"` — new rows are NOT born unset.

## 2. Mutations

- [x] 2.1 In `filter-bar/treeMutations.ts`, add `unsetAllOperators(tree: FilterTree): FilterTree` — maps every row to `{ ...row, op: null }`, **skipping** rows whose `column.kind === "raw"` (those are returned unchanged), preserving `rows` order, each `id`, `enabled`, `column`, `value`, and `tree.combinator`.
- [x] 2.2 Leave `clearAllRows` exactly as-is — it becomes the implementation of the new `Clear all` button.
- [x] 2.3 Leave `coerceValueForOperator` as-is; it is only ever called with a real `Operator`.

## 3. Row UI — operator picker, column change, value input

- [x] 3.1 `filter-bar/OperatorPicker.tsx`: widen `value` to `Operator | null`. When `value === null`, render `<option value="" disabled>—</option>` as the selected option ahead of the option list; otherwise keep today's `showCurrent` behaviour unchanged. `onChange` still emits `Operator`. Keep `aria-label="Operator"`.
- [x] 3.2 `filter-bar/FilterBar.module.css`: style the placeholder-selected `.opSelect` state with `--text-subtle` (muted, not `--danger`). Follow `DESIGN.md`; no new radii, borders or colors outside the token set.
- [x] 3.3 `filter-bar/ConditionRow.tsx` → `onColumnChange`: when `row.op === null`, keep `op: null`, keep `value` verbatim, and skip the boolean eager-`true` seeding. Otherwise the existing `nextOps.includes(row.op) ? row.op : nextOps[0]!` path is unchanged (guard the `.includes` call so TS is satisfied with the widened type).
- [x] 3.4 `filter-bar/ValueInput.tsx`: widen `Props.op` to `Operator | null`. When `op === null`, pick the control from the **value shape**: `Array.isArray(value)` → `ChipInput`; `{min,max}` object → the BETWEEN range inputs; otherwise the scalar/boolean input for the column category. Do not return `null` (the value must stay visible), and do not run the `BooleanValueInput` eager-`true` commit while the operator is unset.
- [x] 3.5 Confirm `ConditionRow` still hides the operator picker for RAW rows and that a RAW row can never reach `op === null`.

## 4. Compile + persistence

- [x] 4.1 `filter-bar/compileWhere.ts`: change `compileRow(row: FilterRow, …)` to take `CompleteFilterRow` so the `.filter((r) => r.enabled && isCompleteRow(r))` narrowing flows into `compileAnyColumn` / `compileNamedPredicate` without casts. No behavioural change — unset rows were already excluded by the completeness gate.
- [x] 4.2 `filter-bar/migrateLegacyFilterModel.ts`: replace the `if (!r["column"] || !r["op"]) return EMPTY_FILTER_MODEL;` guard with a column-only validity check, and normalise the operator when mapping rows: `op: typeof r["op"] === "string" ? (r["op"] as Operator) : null`. Keep the `or_group` / `mode` / `tree` legacy resets and the `id` backfill unchanged.
- [x] 4.3 Confirm `useTableFilter.normalizePersistedFilter` needs no change (it delegates both halves to the migrator).

## 5. Footer controls

- [x] 5.1 `filter-bar/FilterBar.tsx`: rewire `handleUnset` to `onDraftChange(unsetAllOperators(draft))`.
- [x] 5.2 Add `handleClearAll` → `onDraftChange(clearAllRows(draft))` and render a `Clear all` button in the footer's **left** group next to `Export` / `SQL`, using `styles.footerBtn`. Keep `Operator: [Unset]` where it is (right end of the left group) so the two controls are not adjacent.
- [x] 5.3 Leave all keyboard shortcuts untouched; no shortcut is bound to `Unset` or `Clear all`.
- [x] 5.4 Leave `TableViewerTab.onApplyOnlyRow` unchanged — an unset row applies as any other incomplete row (design D2).

## 6. Tests

- [x] 6.1 `types` tests (`filter-bar/filterRowEquals.test.ts` and wherever `isCompleteRow` is covered): a row with `op: null` is incomplete for every column kind and value shape; two `op: null` rows with the same column+value are structurally equal; `modelToPayload` drops unset rows.
- [x] 6.2 `filter-bar/treeMutations.test.ts`: `unsetAllOperators` nulls every structured row's `op`; preserves `id`/`enabled`/`column`/`value`/order/`combinator`; leaves RAW rows at `op: "RAW"`; is a no-op on an empty row list. Existing `clearAllRows` tests stay green untouched.
- [x] 6.3 `filter-bar/FilterBar.test.tsx`: rewrite the `Unset` test — it now asserts row count is preserved and every non-RAW row's `op` is `null` with column/value/enabled/combinator intact. Add a `Clear all` test asserting the old single-empty-row behaviour. Add a RAW-row-untouched-by-Unset test.
- [x] 6.4 `filter-bar/compileWhere.test.ts`: a draft containing an unset row compiles to a WHERE body that omits it; an all-unset draft compiles to `""`.
- [x] 6.5 `filter-bar/migrateLegacyFilterModel.test.ts`: a persisted row with `op: null` rehydrates as an unset row and does NOT reset the model; a row with `op` absent likewise; a row with a missing `column` still resets to the empty model; the existing `mode`/`tree`/`or_group` reset cases stay green.
- [x] 6.6 `TableViewerTab.test.tsx`: replace `"Unset resets value input to empty and clears draft rows"` with a test asserting the typed value **survives** Unset while the operator picker shows the placeholder; add a test that `Unset` → `Apply All` leaves the grid unfiltered with the draft rows still rendered.
- [x] 6.7 `ValueInput` coverage: with `op === null`, an array value renders the chip input, a `{min,max}` value renders the range inputs, a scalar renders the text input, and no eager boolean commit fires.
- [x] 6.8 Run `pnpm -C packages/app test` (or the repo's configured test command) and `pnpm -C packages/app typecheck`; fix any residual `Operator | null` type errors surfaced outside the files listed above.

## 7. Docs and verification

- [ ] 7.1 Manual check in the running app: build a three-row filter, `Apply All`, then `Unset` → all three rows remain with columns and values, operators show `—`, grid still filtered, dirty pip visible; `Apply All` → grid unfiltered, rows still present; pick an operator on one row → row works again.
- [ ] 7.2 Manual check: `Clear all` → single empty row, `applied` untouched until `Apply All`.
- [ ] 7.3 Manual check: unset a filter, quit and relaunch Argus, reopen the table → rows and values restored, operators still unset, `applied` intact.
- [x] 7.4 Add a `CHANGELOG.md` entry under the unreleased section describing the behaviour change (`Operator: Unset` no longer deletes filter rows; new `Clear all` button), referencing issue #278.
- [x] 7.5 Check `README.md` and `docs/` for any prose describing `Unset` as the clear-all control and update it if present.
