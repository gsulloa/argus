## Why

Editing a Postgres column whose type is an array of a quoted, mixed-case custom enum fails with `42704 type "default$default.featureflags[]" does not exist`. Argus lowercases the complete `pg_catalog.format_type` result before reusing it as a cast target, changing the identity of names such as `"default$default"."FeatureFlags"[]`; after preserving that identity, the same path would still mis-handle the JSON array text emitted by the editor as though it were a native Postgres array literal.

## What Changes

- Preserve the exact, trimmed `pg_catalog.format_type` output for fallback SQL casts, including schema qualification, quoted identifiers, mixed case, and the `[]` suffix. Built-in type classification may use a separate lowercase normalized key, but that key MUST NOT be emitted as the fallback cast target.
- Add an array-aware edit bind path for one-dimensional Postgres arrays. It accepts the canonical JSON array produced by the grid editor, binds its scalar/null elements as `text[]`, and lets Postgres cast that value to the exact declared array type.
- Preserve full JSON serialization for elements of `json[]` and `jsonb[]`, including quoted string scalars and structured object/array elements, while retaining scalar-only validation for enum and other non-JSON arrays.
- Require JSON strings for precision-sensitive built-in numeric arrays so frontend JSON parsing cannot silently round `bigint`, `numeric`, or `money` elements before an update.
- Render array placeholders as `$N::text[]::<exact-array-type>`, so `tokio-postgres` serializes a native text array while Postgres performs element-wise conversion to enum or other declared element types.
- Reject malformed JSON, non-array input, nested arrays, and object elements with an `AppError::Validation` that names the column before any transaction starts.
- Add regression coverage for quoted mixed-case enum arrays, lowercase custom types, special-character schema names, null arrays, scalar custom types, and invalid array values.
- No command, payload, or frontend API changes.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `postgres-data-edit`: strengthen type-aware edit binding so fallback casts preserve the exact custom type identity and one-dimensional Postgres arrays accept the grid's canonical JSON representation.

## Impact

- **Backend:** `packages/app/src-tauri/src/modules/postgres/binding.rs` gains separate classification/cast representations and array-aware binding; `packages/app/src-tauri/src/modules/postgres/edit.rs` gains SQL-builder regression tests.
- **Frontend:** no behavior or wire-shape change; the existing array textarea continues to send canonical JSON.
- **Database:** no migration and no schema mutation. The generated parameter expression changes only for array columns and custom fallback types.
- **APIs/dependencies:** no Tauri signature changes and no new dependencies.
- **Risk:** contained to dynamic Postgres edit/filter binding. Exact cast targets remain catalog-derived rather than user-authored, and every value remains parameterized.
