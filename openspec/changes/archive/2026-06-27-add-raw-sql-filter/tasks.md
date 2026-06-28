## 1. Backend types and compilation (`src-tauri/src/modules/postgres/data.rs`)

- [x] 1.1 Add `#[serde(rename = "RAW")] Raw` variant to the `Operator` enum.
- [x] 1.2 Add a `Raw` variant to the `ColumnRef` enum (serde-tagged to match the TS `{ kind: "raw" }` shape, alongside `Named` / `AnyColumn`).
- [x] 1.3 In `compile_condition` / `predicate_for`, handle the RAW case: when `column` is `Raw` and `op` is `Raw`, emit the trimmed `value` string wrapped as `(<expr>)` verbatim, allocating no bind parameter and applying no identifier quoting.
- [x] 1.4 Add validation rejecting (a) `op == Raw` with a non-`Raw` column, (b) a `Raw` column with any non-`Raw` op, and (c) a RAW row whose `value` is absent, non-string, or empty/whitespace — each returning `AppError::Validation`.
- [x] 1.5 Confirm the RAW fragment joins correctly with bound fragments under the root combinator and inside an `or_group`, and that the parameter index for following bound rows is unaffected (no slot consumed).

## 2. Backend tests (`src-tauri/src/modules/postgres/data.rs` test module)

- [x] 2.1 Test: RAW condition compiles to `(<expr>)` verbatim with no params.
- [x] 2.2 Test: RAW row combined with a bound row under `AND` produces `"country" = $1 AND (<expr>)` with `$1` bound and the RAW fragment param-free.
- [x] 2.3 Test: empty/whitespace/absent RAW value is rejected with `AppError::Validation`.
- [x] 2.4 Test: `RAW` op on a named column, and a non-`RAW` op on a `raw` column, are both rejected.
- [x] 2.5 Verify the same compilation path is exercised by `postgres_count_table` (shared `filter_tree`). _(Both commands route through `build_where_body` → `compile_filter_tree`; covered by the shared compile tests.)_

## 3. Frontend filter model (`packages/app/src/modules/postgres/data/types.ts`)

- [x] 3.1 Add `"RAW"` to the `Operator` union.
- [x] 3.2 Add `{ kind: "raw" }` to the `ColumnRef` union.
- [x] 3.3 Extend `isCompleteRow` so a RAW row is complete iff `typeof value === "string" && value.trim() !== ""`.
- [x] 3.4 Ensure the wire conversion (`modelToPayload` / `WireCondition`) emits RAW rows as `{ kind: "condition", column: { kind: "raw" }, op: "RAW", value }` and drops incomplete ones.
- [x] 3.5 Confirm `migrateLegacyFilterModel` drops (rather than throws on) an unrecognized operator, so a RAW row authored on a newer build degrades gracefully on downgrade. _(Verified: the migrator is permissive and never throws — it passes rows through by shape, so RAW round-trips on the current build and degrades to a backend validation error, not a crash, on a downgrade. No code change needed.)_

## 4. Frontend filter bar UI (`packages/app/src/modules/postgres/data/filter-bar/`)

- [x] 4.1 `operatorRules.ts`: keep `RAW` out of the per-column operator lists (it is reached via the column picker, not the operator dropdown).
- [x] 4.2 `ColumnPicker.tsx`: add a `Raw SQL` pseudo-entry next to `Any column`; selecting it sets `column = { kind: "raw" }` and pins `op = "RAW"`.
- [x] 4.3 `ConditionRow.tsx`: when `column.kind === "raw"`, hide/disable the operator picker and render the expression input across the operator+value region; keep checkbox, Apply/Applied, `−`/`+`. Restore structured inputs when the column is switched back to named/any.
- [x] 4.4 `ValueInput.tsx` (or a dedicated raw input): render a monospace single-line expression input using the `DESIGN.md` mono token, with placeholder `data->>'estado' = 'activo'`.
- [x] 4.5 `compileWhere.ts`: render a RAW row as `(<expr>)` verbatim, joined with the other rows under the root combinator (for the footer `SQL` preview / copy / export paths).

## 5. Frontend tests

- [x] 5.1 `compileWhere.test.ts`: RAW row compiles to `(<expr>)` and combines with structured rows under AND/OR.
- [x] 5.2 `types`/`isCompleteRow` test: empty RAW row is incomplete and excluded from the payload; non-empty RAW row is included with the correct wire shape.
- [x] 5.3 `ColumnPicker` / `ConditionRow` test: picking `Raw SQL` swaps in the expression input and hides the operator picker; switching back restores structured inputs.
- [x] 5.4 `FilterBar` test: a RAW row clears via `−` and via `Unset` without affecting sibling rows.

## 6. Spec, docs, and verification

- [x] 6.1 Run `openspec validate add-raw-sql-filter --strict` and resolve any issues. _(Passes.)_
- [x] 6.2 Update `README.md` "Context folders" / data-grid filter docs to mention the `Raw SQL` filter row and its `jsonb` use case (if filters are documented there). _(N/A: the data-grid filter operators are not documented in README; the only filter mention is DynamoDB. Behaviour is captured in the `postgres-data-grid` spec instead.)_
- [x] 6.3 Run `cargo test` (Rust) and the frontend test suite; confirm all green. _(Rust: 67 passed in `postgres::data`, `cargo check` clean. Frontend: 326 passed across 23 files in `postgres/data`, typecheck clean.)_
- [x] 6.4 Manual smoke: open a Postgres table with a `jsonb` column, add a `Raw SQL` row `data->>'estado' = 'activo'`, combine with a structured row, Apply All, confirm correct rows and the footer SQL preview; confirm `DESIGN.md` compliance (mono input, no slop). _(Verified manually by the user.)_
