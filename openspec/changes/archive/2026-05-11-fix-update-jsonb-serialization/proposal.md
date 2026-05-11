## Why

When the user edits a `jsonb` (or `json`) cell, Argus stores the value as a **JSON string scalar** in Postgres instead of as the parsed JSON object/array the user typed. The captured SQL on the wire is

```
WITH _argus_r AS (UPDATE "market"."product_source_info" SET "metadata" = $1 WHERE "id" = $2 RETURNING *) SELECT row_to_json(_argus_r)::text FROM _argus_r;
```

with `$1` bound as a `String` containing the JSON text (e.g. `{"a":1}`). Postgres' jsonb parser happily accepts a JSON-encoded string and stores it as a jsonb string scalar — so the cell that should hold `{"a":1}` ends up holding `"{\"a\":1}"`. Subsequent reads, JSON-path operators, and downstream consumers all see a quoted string where they expect an object.

Two upstream pieces conspire to produce this:

1. **Frontend canonicalization re-stringifies the parsed JSON.** `validateJsonInput` (used by `EditableCell.tsx:227` and `Inspector.tsx`) returns `result.canonical = JSON.stringify(parsed)`. The commit handler passes that canonical *string* to the buffer, so the value travels to the backend as `serde_json::Value::String("{\"a\":1}")`, not as a `Value::Object(...)`.
2. **Backend binds `JsonValue::String` directly as jsonb without re-parsing.** `bind_scalar` in `src-tauri/src/modules/postgres/binding.rs:350-353` does `Box::new(v.clone())` for `BindKind::Json | Jsonb` and renders the placeholder as `Plain` (no cast). When `v` is `JsonValue::String("…")`, tokio-postgres' `ToSql for serde_json::Value` encodes it as a JSON string and Postgres stores it as a string scalar — the JSON inside the string is never parsed.

The earlier `fix-edit-type-aware-binding` change made the placeholder type-aware, and `fix-json-edit-smart-quote-corruption` added frontend JSON parsing — but neither closes the gap where a *valid-JSON string* gets stored as a jsonb string scalar. The backend must be the final guard: when the column is `json`/`jsonb` and the incoming value is a JSON string, re-parse it before binding.

## What Changes

- **Treat `JsonValue::String` as JSON text when binding to a `json`/`jsonb` column.** In `bind_scalar` (and via it `bind_edit_value`/`bind_filter_value`), when `kind` is `Json` or `Jsonb` and the incoming value is `JsonValue::String(s)`:
  - Attempt `serde_json::from_str::<JsonValue>(&s)`.
  - On success, bind the **parsed** value (so `"{\"a\":1}"` from the frontend becomes a jsonb object).
  - On failure, return `AppError::Validation` whose message names the column and reports the parse error (e.g. `invalid JSON for column 'metadata': expected value at line 1 column 2`). The edit MUST NOT silently fall through to storing a malformed string.
- **Continue to accept non-string JSON values (object, array, number, bool, null) without re-parsing.** They're already structured JSON; no double-decode.
- **Keep the placeholder shape `Plain` (`$N` with no cast).** `tokio_postgres` binds `serde_json::Value` to jsonb natively; the cast isn't needed and adding one only complicates the SQL.
- **Add a Rust unit test matrix** covering: object string → object, array string → array, primitive string (`"\"hello\""`) → string scalar, invalid string (`hello` unquoted, `{bad}`) → validation error, real `Value::Object`/`Value::Array` → bound unchanged, `Value::Null` → typed `None` (unchanged).
- **Add a regression test on `build_edit_sql`** asserting that an UPDATE on a jsonb column whose `changes` value is a JSON-encoded string produces `params[0]` whose downcast to `serde_json::Value` is an object, not a string.
- **No frontend changes.** The frontend may continue to send canonical JSON strings; the backend now normalizes them. (Sending pre-parsed JSON values would also work — both shapes converge on the same bound value.)

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `postgres-data-edit`: the **Edit-SQL builder** requirement is extended with a sub-requirement on `json`/`jsonb` binding semantics: a `JsonValue::String` value for a `json`/`jsonb` column MUST be parsed as JSON before binding; an unparseable string MUST surface `AppError::Validation` with the column name and parse error. The existing scenarios are unchanged; new scenarios are appended.

## Impact

- **Code**: `src-tauri/src/modules/postgres/binding.rs` — narrow change inside `bind_scalar`'s `BindKind::Json | BindKind::Jsonb` arm, plus an extra match arm for `JsonValue::String`. Possibly a small private helper `parse_json_string(s, column) -> AppResult<JsonValue>` to share between `bind_scalar` and any future entry points. `src-tauri/src/modules/postgres/edit.rs` — only the existing builder tests gain coverage; no logic change.
- **APIs**: no Tauri command signature changes. `EditOp` payload shape unchanged. Frontend wire format unchanged (canonical JSON string is still acceptable).
- **Spec**: `openspec/specs/postgres-data-edit/spec.md` — Edit-SQL builder requirement gains a `json/jsonb string normalization` sub-requirement and two scenarios (success and validation failure).
- **Dependencies**: none — reuses `serde_json::from_str`.
- **Interaction with in-flight changes**:
  - `fix-edit-type-aware-binding` (the placeholder-type rewrite) is the parent of this fix and must land first. The change here patches the `Json | Jsonb` arm it introduced.
  - `fix-json-edit-smart-quote-corruption` adds frontend JSON parsing; this backend fix is complementary and protects against any code path (e.g. SQL pasted from the SQL editor's parameter binding, future bulk-import) that bypasses the frontend validator.
- **Risk**: low. The change is scoped to one arm of one function. Worst case if `from_str` is over-eager: a string the user *really* wanted stored as a jsonb string scalar (e.g. literal `"hello world"` with surrounding quotes) would be re-parsed — but `serde_json::from_str("\"hello world\"")` returns `Value::String("hello world")`, which round-trips back to the same jsonb string scalar. Unquoted text like `hello world` is not valid JSON and would (correctly) be rejected — the user must wrap it in quotes to mean a jsonb string.
