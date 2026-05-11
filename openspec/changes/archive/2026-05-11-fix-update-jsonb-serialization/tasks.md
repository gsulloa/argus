## 1. Reproduce and pin the bug

- [ ] 1.1 Connect to the user's Postgres (the `meki` instance, schema `market`, table `product_source_info`), run an UPDATE on the `metadata` (`jsonb`) column with an object value via the data viewer, and capture the resulting `jsonb_typeof(metadata)` → confirm it is currently `'string'` for those rows.
- [x] 1.2 Add an `#[ignore]`d Rust test in `src-tauri/src/modules/postgres/binding.rs` that documents the failure shape (a `Value::String("{\"a\":1}")` bound to a jsonb column round-trips as a jsonb string scalar). Mark it `#[ignore = "regression: re-enable after fix"]`.

## 2. Implement string normalization in `bind_scalar`

- [x] 2.1 In `src-tauri/src/modules/postgres/binding.rs`, locate the `BindKind::Json | BindKind::Jsonb` arm in `bind_scalar` (`binding.rs:350-353`).
- [x] 2.2 Add a match-on-`v` inside that arm:
      - `JsonValue::String(s)` → call `serde_json::from_str::<JsonValue>(s)`. On `Ok(parsed)`, bind `Box::new(parsed)` with `PlaceholderTemplate::Plain`. On `Err(e)`, return `AppError::Validation(format!("invalid JSON for column '{column}': {e}"))`.
      - Everything else (`Number`/`Bool` — `Null`/`Array`/`Object` cannot reach here) → keep the existing `Box::new(v.clone())` behavior.
- [x] 2.3 Verify `bind_edit_value`'s `JsonValue::String` path now flows through the new code. The `Array`/`Object` early-return in `bind_edit_value` is unchanged; the `Null` early-return is unchanged. No new branches in `bind_edit_value`.
- [x] 2.4 Compile: run `cargo check -p argus_lib` (or the workspace equivalent — see `src-tauri/Cargo.toml`). Resolve any compile errors.

## 3. Unit tests in `binding.rs`

- [x] 3.1 Add `bind_edit_value_jsonb_object_string_parsed_to_object`: input `Value::String("{\"a\":1}")` with `BindKind::Jsonb`. Asserts placeholder is `Plain` and that `bp.value`, downcast to `serde_json::Value`, is `Value::Object` with key `"a"` mapping to `1`.
- [x] 3.2 Add `bind_edit_value_jsonb_array_string_parsed_to_array`: input `Value::String("[1,2,3]")` → `Value::Array`.
- [x] 3.3 Add `bind_edit_value_jsonb_quoted_string_parsed_to_string`: input `Value::String("\"hello\"")` → `Value::String("hello")` (quoted JSON string round-trips to a JSON string scalar).
- [x] 3.4 Add `bind_edit_value_jsonb_invalid_string_rejected`: input `Value::String("{not json}")` → `Err(AppError::Validation)` whose message contains `"column 'metadata'"` (use `"metadata"` as the column name in the test).
- [x] 3.5 Add `bind_edit_value_jsonb_unquoted_text_rejected`: input `Value::String("hello")` → `Err(AppError::Validation)`. Confirms unquoted free-text is rejected.
- [x] 3.6 Add `bind_edit_value_jsonb_native_object_unchanged`: input `Value::Object` → bound as `Value::Object` (sanity check that the existing path still works).
- [x] 3.7 Add `bind_edit_value_jsonb_null_unchanged`: input `Value::Null` → `Box<Option<JsonValue>>::None` (existing null path).
- [x] 3.8 Add the same matrix scoped to `BindKind::Json` (`bind_edit_value_json_string_parsed_to_object`, etc.) — at minimum the success and invalid-string cases.
- [x] 3.9 Un-`#[ignore]` the regression test from 1.2 once it passes.

## 4. Regression test in `edit.rs`

- [x] 4.1 Add `build_update_jsonb_string_input_normalized_to_object` in `src-tauri/src/modules/postgres/edit.rs`. Set up `columns` with `id integer`, `metadata jsonb`. Call `build_edit_sql` with `op = update { pk: { id: 1 }, changes: { metadata: "{\"a\":1}" } }`. Assert `sql` contains `SET "metadata" = $1 WHERE "id" = $2` and that `params[0].value.downcast_ref::<serde_json::Value>()` is `Some(&Value::Object(...))` with `"a" => 1`.
- [x] 4.2 Add `build_update_jsonb_invalid_string_rejected` that calls `build_edit_sql` with `changes: { metadata: "{bad}" }` and asserts the result is `Err(AppError::Validation)` whose message names `metadata`.

## 5. Manual smoke-test against the `meki` Postgres

- [ ] 5.1 Reproduce the original UPDATE on `market.product_source_info.metadata` from a clean DB row. After the fix, verify `jsonb_typeof(metadata) = 'object'`.
- [ ] 5.2 Insert a row with `metadata = "[1, 2, 3]"` (string from the editor) and verify `jsonb_typeof = 'array'` and `jsonb_array_length = 3`.
- [ ] 5.3 Try saving an invalid JSON string into the cell (e.g. `{foo: bar}`); verify the apply call surfaces a validation error and the row is **not** modified.
- [ ] 5.4 Try saving the literal `"\"hello\""` (a JSON-string scalar) and verify `jsonb_typeof = 'string'` (legitimate string scalar use case still works).
- [ ] 5.5 Try saving SQL `NULL` (cell → NULL toggle); verify `metadata IS NULL`.
- [ ] 5.6 Regress one non-json column (`text`, `integer`) to confirm no collateral damage in `bind_scalar`.

## 6. Update spec and validate

- [x] 6.1 Run `openspec validate fix-update-jsonb-serialization`; resolve any reported issues.
- [x] 6.2 Run `openspec status --change fix-update-jsonb-serialization`; confirm `isComplete: true` for all artifacts.
- [ ] 6.3 At archive time (`/opsx:archive`), the MODIFIED Requirement in `specs/postgres-data-edit/spec.md` will be merged into the live spec. Confirm the existing Scenarios that the delta supersedes (the original three placeholder-cast scenarios from the pre-`fix-edit-type-aware-binding` era) are not regressed.

## 7. Ship

- [ ] 7.1 Open a PR titled "edit: parse JSON-string input before binding to jsonb columns" (or similar). The branch is already `gsulloa/fix-update-jsonb-serialization`.
- [ ] 7.2 In the PR body, include: the user-reported reproducer SQL, the before/after of `jsonb_typeof` on a representative row, and a one-line note on the manual cleanup query for any historic rows: `UPDATE … SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';`.
- [ ] 7.3 Reference the parent change `fix-edit-type-aware-binding` and note that this PR layers on top of it. Request review and land on the beta branch (`gsulloa/beta-release`).
