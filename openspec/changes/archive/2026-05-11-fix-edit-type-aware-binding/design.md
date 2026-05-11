## Context

The Argus Postgres edit path (`postgres_apply_table_edits` → `build_edit_sql`) builds wrapped UPDATE/INSERT/DELETE statements like:

```sql
WITH _argus_r AS (
  UPDATE "market"."product"
  SET "metadata" = $1::jsonb
  WHERE "id" = $2::integer
  RETURNING *
)
SELECT row_to_json(_argus_r)::text FROM _argus_r
```

It binds every parameter as `Option<String>` (see `json_to_param` in `src-tauri/src/modules/postgres/edit.rs:66-77`). The author's intent was to lean on the per-placeholder `::<type>` cast and let Postgres convert the text on the server. This works for *some* column types (text, integer, bigint, etc.) because Postgres's parameter-type inference resolves `$1::integer` to "$1 is text → cast to integer", and `tokio-postgres`'s `Option<String>` ToSql impl satisfies the text type.

It does not work for `jsonb`. When `tokio-postgres` prepares the statement, the server returns its inferred type for `$1` (the input side of `::jsonb`). For jsonb-cast contexts within a CTE-wrapped UPDATE, the inferred type does not match what `Option<String>::accepts()` allows, so the client-side ToSql validation fails with `error serializing parameter 0` before any bytes hit the wire. The same client-side check causes failures on additional types (uuid, numeric, date, time(tz), timestamp(tz), bytea) in some statement shapes.

The recently-shipped structured-filter feature (`src-tauri/src/modules/postgres/data.rs:189-517`) solved exactly this problem with a typed binding strategy:

- Each Postgres column type maps to a `BindKind` (Int2/Int4/Int8/Float4/Float8/Bool/Numeric/Text/Uuid/Date/Time/TimeTz/Timestamp/TimestampTz/Bytea/Json/Jsonb/Fallback).
- `bind_value(json, column, kind)` returns a `BoundParam { value: Box<dyn ToSql + Sync + Send>, placeholder: PlaceholderTemplate }`.
- Native primitive types (Int*, Float*, Bool) bind as Rust primitives (`i16`, `i32`, `i64`, `f32`, `f64`, `bool`) with `PlaceholderTemplate::Plain` → renders `$N`.
- Cast-from-text types (Numeric, Uuid, Date, Time, TimeTz, Timestamp, TimestampTz, Bytea, Json, Jsonb, Fallback) bind as `String` with `PlaceholderTemplate::Cast("type")` → renders `$N::type`.
- Text columns bind as `String` with `Plain`.

The filter path validated this works against real Postgres for every type Argus currently surfaces in the data viewer. The fix is to share that machinery with the edit path.

## Goals / Non-Goals

**Goals:**

- UPDATE/INSERT against jsonb columns succeed with both scalar JSON values (e.g. `{"a": 1}`) and explicit-string JSON (e.g. `"{\"a\":1}"`).
- All currently-working edit cases (text, integer, bigint, etc.) keep working with semantically equivalent SQL and equal-or-stronger client-side type checking.
- A single `BindKind`/`bind_value` module is the source of truth for how Argus binds JSON values to Postgres parameters. Filters and edits both consume it.
- NULL handling is type-correct: `null` for an `integer` column binds as `Option::<i32>::None`, not `Option::<String>::None` with a server-side cast.
- Bind-time errors (e.g. "value 'abc' is not a valid integer for column 'age'") fail the whole apply call as `AppError::Validation` *before* any `BEGIN` is dispatched, matching the existing pre-flight builder discipline.

**Non-Goals:**

- Changing the Tauri command surface (`postgres_apply_table_edits`, `postgres_table_primary_key`, `EditOp` shape).
- Changing the wrapped `WITH _argus_r AS (...) SELECT row_to_json(_argus_r)::text` strategy used to capture `RETURNING *`.
- Supporting array column types as a structured ToSql bind (we keep them in the `Fallback(type_name)` bucket: text body + server-side cast).
- Adding new column types to the data viewer (enums, ranges, geometric types beyond Fallback). They keep working via the Fallback path.
- Sharing the *filter*-side validation rules (e.g. "null is not allowed in a filter value") with the edit path. Edits explicitly accept null.

## Decisions

### Decision 1: Extract the binding helpers into a shared module

**Choice:** Move `BindKind`, `BoundParam`, `PlaceholderTemplate`, `bind_kind_for_type`, `normalize_pg_type`, `coerce_to_string`, `parse_int_value`, `parse_float_value`, and `ColumnTypeIndex` from `data.rs` into a new module `src-tauri/src/modules/postgres/binding.rs`. `bind_value` itself splits into two entry points (see Decision 2). Re-export from `data.rs` as needed for the filter path.

**Why:** Both the filter path and the edit path need the same column-type → bind-kind mapping. Duplicating it would let them drift; importing from `data.rs` into `edit.rs` works but conflates "data viewer query/filter" with reusable binding plumbing. A small `binding.rs` module is the cleanest shape.

**Alternatives considered:**

- Leave the helpers in `data.rs` and `pub(crate)` them. Quick, but ties two unrelated capabilities to one module and complicates future refactors (e.g. if SQL editor wants the same binding for parameterized queries someday).
- Move into a top-level `src-tauri/src/postgres_binding.rs`. Rejected — module belongs under `modules::postgres`.

### Decision 2: Two `bind_value` variants, one core

**Choice:** Keep one core function `bind_scalar(v: &JsonValue, column: &str, kind: &BindKind) -> AppResult<BoundParam>` that handles non-null scalar values exactly like the current `bind_value`. Add two thin wrappers:

- `bind_filter_value(v, column, kind)` — rejects `null`, `array`, `object`. Used by the filter path. Behavior identical to today's `bind_value`.
- `bind_edit_value(v, column, kind)` — accepts `null` (returns a `BoundParam` with `Option::<T>::None` of the correct inner type and the correct placeholder), accepts `array`/`object` only when `kind` is `Json` or `Jsonb` (serializes to a JSON string), rejects them otherwise.

**Why:** The filter and edit paths have legitimately different rules for null and structured values. Keeping two named entry points makes the call site self-documenting; sharing a `bind_scalar` core means the type-conversion logic lives in exactly one place.

**Alternatives considered:**

- One `bind_value` with a `mode: BindMode` enum. Slightly more central but every call site has to pass the mode anyway. Two named functions are clearer.
- Add an `accept_null: bool` boolean flag. Rejected — booleans at call sites are always opaque.

### Decision 3: `Option::<T>::None` instead of `Option::<String>::None` for NULL

**Choice:** When the JSON value is `null`, `bind_edit_value` returns a `BoundParam` whose `value` is the typed `None` for the column's bind kind:

- `Int2` → `Box::new(Option::<i16>::None)`, placeholder `Plain`.
- `Int4` → `Box::new(Option::<i32>::None)`, `Plain`.
- `Int8` → `Box::new(Option::<i64>::None)`, `Plain`.
- `Float4` → `Box::new(Option::<f32>::None)`, `Plain`.
- `Float8` → `Box::new(Option::<f64>::None)`, `Plain`.
- `Bool` → `Box::new(Option::<bool>::None)`, `Plain`.
- All other kinds → `Box::new(Option::<String>::None)`, `Cast("type")`.

**Why:** `tokio-postgres`'s ToSql for `Option<T>::None` validates the *type* of the inner T against the parameter's expected type, then sends a NULL with that OID. Binding `Option::<String>::None` to an integer column fails the same client-side check that string-bound jsonb fails. By picking the `Option<T>` that matches the column, NULL works for every kind.

**Alternatives considered:**

- Always bind `Option::<String>::None` and rely on the SQL cast (current behavior). This is the very source of the bug — keep moving.
- Pre-translate JSON null to a literal `NULL` token in the SQL string. Rejected — that means edits can no longer be a pure parameter-bound builder, and we lose tokio-postgres' parameter validation.

### Decision 4: Array/object only for json/jsonb columns

**Choice:** In `bind_edit_value`, JSON `array` and `object` values are:

- Accepted when `kind` is `BindKind::Json` or `BindKind::Jsonb`. The value is serialized via `serde_json::to_string(v).unwrap_or_default()` and bound as `String` with `Cast("json")` / `Cast("jsonb")`.
- Rejected with `AppError::Validation { message: "structured value not allowed for column 'X' of type T" }` for every other kind.

**Why:** A user editing a row's text column shouldn't be able to write a JSON object into it (the frontend prevents this; the backend should refuse defensively). For jsonb specifically, `{"a": 1}` is the natural JSON-as-data shape; we'd be hostile to require the user to wrap it in a string.

**Alternatives considered:**

- Accept structured JSON for any column and let Postgres reject it. Rejected — bind-time validation gives a clearer error and avoids a network round trip.
- Stringify structured values regardless of column kind. Rejected — quietly turns `{"a":1}` into the literal string `'{"a":1}'` for a `text` column, which is almost never what the user meant.

### Decision 5: SQL builder rendering via `BoundParam.placeholder`

**Choice:** In `build_edit_sql`, replace the local `placeholder = |idx, dtype| format!("${idx}::{dtype}")` closure with `bound.placeholder.render(params.len())`. UPDATE-set, UPDATE-where, INSERT-values, and DELETE-where loops all push `BoundParam.value` onto `params` and use `BoundParam.placeholder.render(idx)` to format the placeholder fragment.

**Effect:** SQL for `integer`/`bigint`/`real`/`bool` columns now emits plain `$N` placeholders (no cast) — matching the filter path. SQL for `jsonb`/`uuid`/`date`/`numeric`/`bytea`/etc. continues to emit `$N::<type>`. Text columns now emit plain `$N` (cast was redundant for text).

**Test impact:** The existing `build_update_emits_casts_on_set_and_where` test asserts `SET "name" = $1::text` and `WHERE "id" = $2::bigint`. After this change, those become `SET "name" = $1` and `WHERE "id" = $2`. We update those assertions to the new shape. The behavioral guarantee — "every value bound, every identifier quoted" — is preserved.

**Alternatives considered:**

- Always render `$N::<type>` even for native binds, for visual consistency in the activity-log SQL. Rejected — a redundant cast is technically correct but adds noise to the activity log; also creates an asymmetry with the filter path which already uses plain `$N`.

### Decision 6: Pre-flight validation before BEGIN

**Choice:** Keep the existing pre-build pattern in `postgres_apply_table_edits`: every `EditOp` is fed through `build_edit_sql` before any `BEGIN` is dispatched. Any `AppError::Validation` from `bind_edit_value` (bad integer, structured value on non-json column, etc.) fails the entire apply call with a thrown error — never as an `OpFailed` outcome.

**Why:** The existing apply code already does this for the SQL-shape validation (`changes` non-empty, PK coverage). Bind-value validation joins that pipeline so the contract stays simple: "either every op is buildable and we open a transaction, or none are and the caller sees a Validation error." It also means the activity-log row's `sql` field reflects only successful builds.

**Alternatives considered:**

- Return a partial failure with the failing op's index. Rejected — bind validation errors are programmer/UI bugs (e.g. frontend sent an object for a text column), not the kind of mid-transaction database error that the `OpFailed` variant exists for.

## Risks / Trade-offs

[Risk: regression on currently-working edit types (text/integer/bigint)] → Mitigation: keep all existing builder unit tests, retarget their SQL assertions to the new placeholder shape (plain `$N` for native binds), and add a paired test that re-emits exactly the param values via a mock `to_sql` wrapper to confirm the bound primitives round-trip. Manual smoke-test the `meki` Postgres connection used in the original bug report.

[Risk: silent semantic change for `text` columns — placeholders go from `$1::text` to `$1`] → Mitigation: this is intentional and matches the filter path; document in the spec scenario rewording. No DB-visible behavior change because tokio-postgres binds `String` as text natively.

[Risk: shared module placement creates a circular import (data.rs ↔ binding.rs)] → Mitigation: `binding.rs` depends only on `crate::error` and `tokio_postgres::types::ToSql`; it does NOT import anything from `data.rs`. `data.rs` and `edit.rs` both import from `binding.rs`. `ColumnTypeIndex` lives in `binding.rs` and takes a `&[DataColumn]` — `DataColumn` stays in `data.rs` and is imported by `binding.rs`'s `from_columns` constructor.
   - **Wait — that's a cycle.** Resolution: `ColumnTypeIndex::from_columns` is generic over `IntoIterator<Item = (&str, &str)>` (column name, data_type) so the helper has no `DataColumn` dependency. Both `data.rs` and `edit.rs` adapt their `Vec<DataColumn>` into the generic input via `.iter().map(|c| (c.name.as_str(), c.data_type.as_str()))`. Documented as part of Task 2.

[Risk: structured JSON binding for jsonb misbehaves on edge cases (e.g. strings that look like JSON but aren't)] → Mitigation: test cases — bind a JSON string `"hello"`, JSON number `42`, JSON object `{"a":1}`, JSON array `[1,2,3]`, JSON null, and an explicit JSON-encoded string `"\"hello\""` against a jsonb column. Verify each round-trips via a real Postgres connection in the manual QA step.

[Risk: spec-text update conflicts with in-flight changes touching `postgres-data-edit`] → Mitigation: check `openspec/changes/` for any open change touching the same spec before merging; the only existing changes are `enhance-sql-editor` and `ship-beta-auto-update`, neither touches the edit path.

## Migration Plan

1. Land the binding-module extraction (Task 2) without behavior change to filters. CI green = no regression on filter path.
2. Land the edit-path migration (Tasks 3-4) with all builder tests retargeted to the new placeholder shape and new tests for jsonb/uuid/null. CI green = builder behavior is correct in unit tests.
3. Manual smoke test against the `meki` connection: reproduce the original bug (UPDATE jsonb), then update one row, insert one row, delete one row across at least one jsonb, one uuid, one timestamp, and one integer column.
4. Update the spec (Task 5) and run `openspec validate fix-edit-type-aware-binding`.

No frontend changes required. No data migrations. Rollback = revert the merge commit; the change is contained to the Rust backend.

## Open Questions

None. All design questions have a concrete answer.
