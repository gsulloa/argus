## 1. Shared edit buffer — type-tolerant equality (Layer B)

- [x] 1.1 In `packages/app/src/modules/postgres/data/useEditBuffer.ts`, harden `cellEquals` so a numeric string and its numeric coercion compare equal (e.g. `"100.00"` vs `100`): when exactly one side is a `number` and the other is a numeric-looking `string`, compare by `Number(...)` value; keep the existing strict `JSON.stringify` fallback for all other types.
- [x] 1.2 JSON no-op handled at the editor layer (Layer A) instead of `cellEquals`. Decision: adding a JSON-parse branch to `cellEquals` would falsely collapse a genuine whitespace edit on a non-JSON `text` column holding JSON-looking text (`cellEquals` has no column-type context). The editor's raw-text guard (tasks 2–4) knows the column is JSON and compares the exact text, so an unchanged JSON cell never commits — satisfying the spec scenarios without the false-collapse risk.
- [x] 1.3 Confirmed: `set-cell` and `bulk-set-cell` drop-if-equals-original branches both route through the improved `cellEquals`, and an emptied `update` row is removed via the existing `isEmptyUpdate` path (covered by the new numeric-collapse tests in 5.1).

## 2. Postgres inline editor — commit-only-if-changed guard (Layer A)

- [x] 2.1 In `packages/app/src/modules/postgres/data/EditableCell.tsx`, capture the editor's opening representation (`valueToInputString(initial)` and initial null-ness).
- [x] 2.2 In `commit()`, if the current editor state (`text` + `nullToggle`) is identical to the opening representation, call `onCancel()` instead of `onCommit()` — covering the text, numeric, JSON textarea, boolean-select, and enum-select variants (all commit paths: blur, `Enter`, `Tab`).

## 3. MySQL inline editor — commit-only-if-changed guard (Layer A)

- [x] 3.1 In `packages/app/src/modules/mysql/data/EditableCell.tsx`, apply the same "unchanged → do not commit" guard to every per-type editor component's commit/blur path (text, numeric, JSON, boolean, enum/set editors).
- [x] 3.2 Verify each editor variant initializes its comparison baseline from the value it opened with, so re-selecting the same select option or blurring untouched text is a no-op.

## 4. MSSQL inline editor — commit-only-if-changed guard (Layer A)

- [x] 4.1 In `packages/app/src/modules/mssql/data/EditableCell.tsx`, apply the same "unchanged → do not commit" guard to every per-type editor component's commit/blur path (text, numeric, JSON, boolean editors).
- [x] 4.2 Verify parity with the MySQL editor behavior (same guard, same variants where applicable).

## 5. Tests

- [x] 5.1 Extend `packages/app/src/modules/postgres/data/__tests__/useEditBuffer.test.ts` with `cellEquals`/collapse cases: numeric string `"100.00"` committed as `100` drops the edit; canonicalized JSON committed against the original JSON drops the edit; a genuinely different value is kept.
- [x] 5.2 Add a Postgres `EditableCell` test: double-click (start edit) then blur/`Enter`/`Tab` on an unchanged numeric and JSON cell does NOT call `onCommitEdit` (or results in no dirty buffer entry); a changed value still commits.
- [x] 5.3 Add equivalent no-op-on-unchanged tests to the MySQL `EditableCell` test suite (decimal + text variants).
- [x] 5.4 Add equivalent no-op-on-unchanged tests to the MSSQL `EditableCell` test suite (decimal + text variants).

## 6. Verification

- [x] 6.1 Run the frontend test suite and lint/typecheck for the touched modules; all green.
- [ ] 6.2 Manually reproduce the issue #245 flow (Postgres): double-click a numeric cell, click away, confirm it is NOT highlighted yellow; then edit a value and confirm the yellow dirty highlight still appears; spot-check MySQL and MSSQL grids.
