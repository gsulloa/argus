## Why

UPDATE/INSERT against a `jsonb` column currently fails with `error serializing parameter 0` (e.g. `UPDATE "market"."product" SET "metadata" = $1::jsonb WHERE "id" = $2::integer`). The edit-SQL builder binds every value as `Option<String>` and relies on a server-side `::<type>` cast, but `tokio-postgres` validates the bound Rust type against the prepared statement's inferred parameter type *before* the SQL cast runs. For `jsonb` (and several other types), the inferred type is not text-compatible, so the bind is rejected at the client. This breaks one of Argus' core editing flows on any table with a jsonb column.

The structured-filter feature (commit 28acc9b) already solved this exact class of problem with a type-aware `bind_value` / `BindKind` / `PlaceholderTemplate` strategy living in `src-tauri/src/modules/postgres/data.rs`. The edit path was not migrated and still uses the old "everything is a string + cast" approach. We need to bring the edit path in line.

## What Changes

- Replace `json_to_param` in `src-tauri/src/modules/postgres/edit.rs` with the type-aware binding strategy already used for filters: native primitives for numeric/bool columns (bound as `i16`/`i32`/`i64`/`f32`/`f64`/`bool` with plain `$N` placeholders), and `String` + `$N::<type>` cast for everything else (text, uuid, date, time, timestamp(tz), bytea, json, jsonb, numeric, fallback).
- Extract the binding helpers (`BindKind`, `BoundParam`, `PlaceholderTemplate`, `bind_kind_for_type`, `bind_value`, `coerce_to_string`, `parse_int_value`, `parse_float_value`, `normalize_pg_type`, `ColumnTypeIndex`) from `data.rs` into a shared module `src-tauri/src/modules/postgres/binding.rs` so both `data.rs` (filters) and `edit.rs` (edits) consume the same source of truth.
- Update `build_edit_sql` so each placeholder is rendered via `BoundParam.placeholder.render(idx)` (yielding `$N` for native-bind types and `$N::<type>` for cast-from-text types) instead of unconditionally appending `::<dtype>`.
- Extend `bind_value` semantics for the edit path so that:
  - `null` JSON values are accepted (UPDATE/INSERT must support setting columns to NULL). In the filter path, `null` is a validation error; the edit path needs `Option<T>` binds with the right inner type.
  - JSON `array`/`object` values are accepted for `json`/`jsonb` columns (they're serialized to a JSON string and bound as `String` with a `::jsonb` cast). For non-json columns, array/object remain a validation error.
- Add Rust unit tests covering jsonb update, jsonb null, integer null, integer non-null, uuid update, and timestamp update. Add an `error_messages` test asserting that bind-time validation errors mention the column name.
- **BREAKING (internal contract only)**: the `Vec<JsonValue>` shape stored in `BuiltStatement.params` no longer survives — the SQL builder now returns typed bind params. No frontend or external API surface changes.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `postgres-data-edit`: the **Edit-SQL builder** requirement currently mandates that "all edit values therefore travel as `Option<String>` over the wire" and that "each placeholder MUST be emitted with an explicit `::<data_type>` cast". This is updated to reflect the type-aware binding strategy: native primitives bind directly with plain `$N`; cast-from-text types (uuid, jsonb, json, numeric, date, time(tz), timestamp(tz), bytea, plus a typed-name fallback) bind as `String` with `$N::<type>`. NULL handling is also tightened: `null` JSON values bind as `Option::<T>::None` of the correct inner type, not as `Option::<String>::None`.

## Impact

- **Code**: `src-tauri/src/modules/postgres/edit.rs` (replace `json_to_param`, rewrite `build_edit_sql` placeholder rendering, update tests). `src-tauri/src/modules/postgres/data.rs` (extract helpers into shared module, re-import). New file `src-tauri/src/modules/postgres/binding.rs` (or `src-tauri/src/modules/postgres/type_binding.rs`). `src-tauri/src/modules/postgres/mod.rs` (register the new module).
- **APIs**: no Tauri command signature changes. `EditOp` payload shape unchanged. `postgres_apply_table_edits` behavior unchanged for callers; edits just stop failing on jsonb/uuid/numeric/etc.
- **Spec**: `openspec/specs/postgres-data-edit/spec.md` Edit-SQL builder requirement and one scenario reworded; new scenario added for jsonb update; NULL scenario reworded to match typed-NULL binding.
- **Dependencies**: none (everything reuses existing tokio-postgres `ToSql` impls).
- **Risk**: low. The filter path proves the pattern works on the same set of types. The main hazard is regressing existing edit cases (text/integer/bigint) that *currently* work via the string+cast path; covered by retaining all existing builder tests and asserting the same SQL/output for those columns.
