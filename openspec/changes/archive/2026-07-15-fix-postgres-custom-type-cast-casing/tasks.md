## 1. Preserve Catalog Type Identity

- [x] 1.1 Extend `PlaceholderTemplate` with an array-cast variant that renders `$N::text[]::<exact-array-type>` while leaving existing plain and scalar double-cast rendering unchanged.
- [x] 1.2 Extend `BindKind` with an explicit array variant that owns the exact trimmed `pg_catalog.format_type` value and reports that exact value in diagnostics.
- [x] 1.3 Refactor `bind_kind_for_type` so normalized lowercase text is used only for built-in classification; store the untouched catalog expression for scalar fallbacks and detect `[]` types before scalar classification.
- [x] 1.4 Add unit tests covering built-in case-insensitive classification plus exact preservation of quoted mixed-case scalar types, quoted mixed-case enum arrays, lowercase arrays, and schema names containing special characters.

## 2. Bind One-Dimensional Array Edits

- [x] 2.1 Add a focused array normalizer that accepts either a direct JSON array or a string containing JSON-array text and converts top-level string/number/boolean/null elements into `Vec<Option<String>>`.
- [x] 2.2 Reject malformed JSON, non-array JSON, nested arrays, and object elements with `AppError::Validation` that includes both the column name and exact declared type.
- [x] 2.3 Wire non-null array values through the native `text[]` parameter plus exact target-array cast, including correct handling for empty arrays and direct JSON-array payloads.
- [x] 2.4 Bind whole-column JSON `null` as `Option::<Vec<Option<String>>>::None` with the same array placeholder, preserving the distinction between SQL `NULL`, an empty array, and an array containing `NULL`.
- [x] 2.5 Add binding unit tests for canonical enum-array JSON strings, direct arrays, numbers/booleans, escaped strings, empty arrays, element-level nulls, whole-column null, and every rejected shape.

## 3. SQL Builder Regression Coverage

- [x] 3.1 Add an `edit.rs` builder test reproducing `"default$default"."FeatureFlags"[]` and assert that UPDATE SQL contains `$1::text[]::"default$default"."FeatureFlags"[]` with deterministic PK placeholder numbering.
- [x] 3.2 Add a scalar custom-type regression test proving a catalog target such as `"Tenant"."ExternalId"` is not lowercased in the generated double cast.
- [x] 3.3 Re-run existing native, JSON/JSONB, fallback, filter, and edit-SQL tests and adjust exhaustive matches without changing their established placeholder behavior.

## 4. Validation

- [x] 4.1 Run `cargo fmt --check` for the Tauri crate and resolve formatting drift.
- [x] 4.2 Run the targeted Postgres binding/edit test modules, then the complete Rust test suite, and document any pre-existing unrelated failures. _(Postgres: 200 passed; full Rust: 1503 passed, 0 failed, 1 ignored.)_
- [x] 4.3 Run the frontend typecheck/test suite to confirm the unchanged array-editor payload remains compatible with the backend contract. _(TypeScript clean; Vitest: 133 files passed, 1 skipped; 1681 tests passed, 3 todo.)_
- [x] 4.4 Run `openspec validate fix-postgres-custom-type-cast-casing --strict` and confirm `openspec status --change fix-postgres-custom-type-cast-casing` reports all artifacts complete.

## 5. Pre-Landing Review Follow-up

- [x] 5.1 Preserve complete JSON serialization for `json[]` and `jsonb[]` elements so quoted strings and structured values survive the intermediate `text[]` cast.
- [x] 5.2 Add regression tests for built-in and `pg_catalog`-qualified JSON array targets, then re-run strict spec validation and test suites.
- [x] 5.3 Reject unquoted JSON numbers for precision-sensitive built-in arrays and add exact-lexeme regression coverage.
- [x] 5.4 Document whole-value replacement semantics for non-default array bounds and the existing SQL-null convention for JSON array elements.
