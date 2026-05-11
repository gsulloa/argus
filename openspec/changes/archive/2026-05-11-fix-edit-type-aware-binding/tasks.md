## 1. Reproduce and confirm the bug

- [ ] 1.1 Connect to the `meki` Postgres database and run an UPDATE on `market.product.metadata` (jsonb) through the Argus data viewer; capture the exact `error serializing parameter 0` failure for the regression-test docstring.
- [ ] 1.2 Add a `#[ignore]` integration test in `src-tauri/src/modules/postgres/edit.rs` (or a new `tests/` module) that documents the failure shape, so future regressions are catchable with `cargo test --ignored`.

## 2. Extract binding helpers into a shared module

- [x] 2.1 Create `src-tauri/src/modules/postgres/binding.rs`. Move `BindKind`, `BoundParam`, `PlaceholderTemplate`, `bind_kind_for_type`, `normalize_pg_type`, `coerce_to_string`, `parse_int_value`, `parse_float_value`, and `repr_for_error` from `data.rs` into it. Make their visibility `pub(crate)`.
- [x] 2.2 Move `ColumnTypeIndex` into `binding.rs`. Replace its `from_columns(columns: &[DataColumn])` constructor with a generic `from_iter<I: IntoIterator<Item = (&str, &str)>>(it: I)` so the module has no dependency on `data.rs`. Provide a small adapter helper or inline `.iter().map(|c| (c.name.as_str(), c.data_type.as_str()))` at each call site.
- [x] 2.3 Register the new module in `src-tauri/src/modules/postgres/mod.rs`.
- [x] 2.4 Update `data.rs` to import from `binding` instead of defining the helpers locally. Keep the existing public surface of `data.rs` unchanged.
- [x] 2.5 Rename the existing `bind_value` in `data.rs` to `bind_filter_value`. Verify all filter-path call sites are updated. Run `cargo check` and the existing data/filter test suite — must pass green with zero behavior change.

## 3. Implement `bind_edit_value`

- [x] 3.1 In `binding.rs`, factor the non-null scalar branch of the current `bind_value` into a private `bind_scalar(v, column, kind) -> AppResult<BoundParam>` (rejects `null`, `array`, `object`).
- [x] 3.2 Implement `pub(crate) fn bind_edit_value(v: &JsonValue, column: &str, kind: &BindKind) -> AppResult<BoundParam>` with three branches:
  - `JsonValue::Null` → produce a typed `Option::<T>::None` BoundParam per the table in `design.md` (Decision 3).
  - `JsonValue::Array(_) | JsonValue::Object(_)` with kind `Json` or `Jsonb` → serialize via `serde_json::to_string(v).unwrap_or_default()` and bind as `String` with the `Cast("json")` / `Cast("jsonb")` placeholder.
  - `JsonValue::Array(_) | JsonValue::Object(_)` with any other kind → `AppError::Validation` whose message includes the column name and the bind kind's display name (e.g. `"text"`, `"integer"`).
  - Otherwise → delegate to `bind_scalar`.
- [x] 3.3 Reimplement `bind_filter_value` in `binding.rs` as a thin wrapper around `bind_scalar` with the existing null/array/object rejection rules.
- [x] 3.4 Add a small `BindKind::display_name()` helper (`Int2 => "smallint"`, `Jsonb => "jsonb"`, etc.) for use in error messages.

## 4. Migrate `build_edit_sql` to type-aware binding

- [x] 4.1 In `src-tauri/src/modules/postgres/edit.rs`, delete `json_to_param`. Remove the `placeholder` closure inside `build_edit_sql`.
- [x] 4.2 Build a `ColumnTypeIndex` once at the top of `build_edit_sql` from the `columns` slice.
- [x] 4.3 In each of the UPDATE-set, UPDATE-where, INSERT-values, and DELETE-where loops, replace the `json_to_param(val)` + manual cast with: look up the column's `BindKind` via the index (return `AppError::Validation` if missing — same as today's `resolve_type`), call `bind_edit_value(val, col_name, kind)?`, push `bound.value` onto `params`, render the placeholder via `bound.placeholder.render(params.len())`.
- [x] 4.4 Verify the wrapped `WITH _argus_r AS (...) SELECT row_to_json(_argus_r)::text` shape is preserved for UPDATE and INSERT.
- [x] 4.5 Run `cargo build` from the workspace root; resolve any compile errors.

## 5. Tests

- [x] 5.1 Update existing builder tests in `edit.rs` to match the new placeholder shape: `build_update_emits_casts_on_set_and_where` becomes `build_update_native_columns_emit_plain_placeholders` (asserts `SET "name" = $1`, `WHERE "id" = $2`); `build_insert_uses_only_supplied_columns_with_cast` becomes `build_insert_text_column_no_cast` (asserts `VALUES ($1)`); `build_delete_with_composite_pk_casts_each` becomes `build_delete_integer_pk_no_cast`; `null_value_against_integer_column_emits_typed_null` becomes `null_on_integer_column_binds_typed_none` (asserts placeholder is `$1` and `params[0].value.downcast_ref::<Option<i32>>()` is `Some(&None)`).
- [x] 5.2 Add `build_update_jsonb_column_emits_cast` covering the original bug. Inputs: `update { pk: { id: 1 }, changes: { metadata: {"a": 1} } }`, columns `id integer`, `metadata jsonb`. Asserts `SET "metadata" = $1::jsonb WHERE "id" = $2` and that `params[0]` round-trips to the JSON-encoded string `{"a":1}`.
- [x] 5.3 Add `build_update_jsonb_null` covering null on jsonb. Asserts `SET "metadata" = $1::jsonb` with `params[0]` = `Option::<String>::None`.
- [x] 5.4 Add `build_update_uuid_column_emits_cast` and `build_update_timestamptz_column_emits_cast` to lock in the cast-from-text behavior for two more types.
- [x] 5.5 Add `build_update_structured_value_on_text_column_rejected` (object on `text` column → `AppError::Validation` mentioning `"name"` and `"text"`).
- [x] 5.6 Add `build_update_out_of_range_int_rejected` (smallint with value `999999999999` → `AppError::Validation`).
- [x] 5.7 Add a test in `binding.rs`'s `#[cfg(test)] mod tests` that exercises `bind_edit_value` directly for each `BindKind` with a representative non-null value, with `null`, and with structured JSON. Asserts the placeholder shape and the runtime type of the boxed value (via `Any::downcast_ref`).
- [x] 5.8 Run `cargo test -p argus_lib` (or whatever the workspace test command is — check `package.json` / `src-tauri/Cargo.toml`); all unit tests must pass.

## 6. Manual smoke-test against the meki Postgres

- [ ] 6.1 Reproduce the original failing UPDATE on `market.product.metadata`; confirm it now succeeds.
- [ ] 6.2 INSERT a row into a table with a jsonb column; verify the row appears with the jsonb value intact.
- [ ] 6.3 UPDATE a row setting a jsonb column to JSON `null`; verify the column reads back as SQL `NULL`.
- [ ] 6.4 UPDATE a row setting a jsonb column to a JSON string (e.g. `"hello"`); verify Postgres stores it as `jsonb` `"hello"`.
- [ ] 6.5 UPDATE rows touching at least one `uuid`, one `timestamptz`, one `integer`, and one `text` column to confirm no regression.
- [ ] 6.6 DELETE a row by integer PK and by uuid PK to confirm both work.

## 7. Update spec and validate

- [ ] 7.1 Apply the spec delta from `specs/postgres-data-edit/spec.md` into the live `openspec/specs/postgres-data-edit/spec.md` per the OpenSpec archive workflow (this happens at archive time via `openspec archive fix-edit-type-aware-binding` or `/opsx:archive`).
- [ ] 7.2 Run `openspec validate fix-edit-type-aware-binding`; resolve any reported issues.
- [ ] 7.3 Run `openspec status --change fix-edit-type-aware-binding`; confirm `isComplete: true`.

## 8. Ship

- [ ] 8.1 Open a PR titled "edit: type-aware Postgres parameter binding (fix jsonb update)".
- [ ] 8.2 Reference the original error in the PR body; include before/after of an example UPDATE statement.
- [ ] 8.3 Request review and land on master.
