## 1. Type-resolution scaffolding (Rust)

- [x] 1.1 In `src-tauri/src/modules/postgres/data.rs`, add a `normalize_pg_type(raw: &str) -> &str` helper that lowercases and strips parameterized modifiers (`varchar(255)` → `varchar`, `numeric(10,2)` → `numeric`, `timestamp(6) with time zone` → `timestamp with time zone`). Cover the verbose `information_schema` forms.
- [x] 1.2 Add a `BindKind` enum mapping every supported normalized type to its `(rust_target, placeholder_template)` pair, plus a `Fallback(canonical_name)` variant for unknown types. Place it next to `json_to_param`.
- [x] 1.3 Add a `ColumnTypeIndex<'a>` newtype around `HashMap<&'a str, &'a str>` (column name → normalized data type) and a `ColumnTypeIndex::from_columns(&[Column])` constructor.

## 2. `bind_value` core (Rust)

- [x] 2.1 Replace `json_to_param(&JsonValue) -> AppResult<Box<dyn ToSql + …>>` with `bind_value(value: &JsonValue, column_name: &str, kind: BindKind) -> AppResult<BoundParam>` returning the boxed value plus a `PlaceholderTemplate` (`Plain` or `Cast(&'static str)`).
- [x] 2.2 Implement integer arms (`int2`/`int4`/`int8`): accept `JsonValue::Number(as_i64)` and `JsonValue::String(parse::<i64>())`, range-check against the target type, return validation error on miss with the format `"expected integer for column '<name>', got '<repr>'"`.
- [x] 2.3 Implement float arms (`float4`/`float8`): accept `JsonValue::Number` (any) and `JsonValue::String` parseable to the target.
- [x] 2.4 Implement `numeric`/`decimal`: accept `Number` (use `.to_string()`) or `String`, bind as `String`, placeholder `Cast("numeric")`.
- [x] 2.5 Implement `bool`: require `JsonValue::Bool`.
- [x] 2.6 Implement text family (`text`/`varchar`/`bpchar`/`name`/`citext`): require `JsonValue::String`, placeholder `Plain`. Coerce `Number`/`Bool` to their `to_string()` form as a courtesy.
- [x] 2.7 Implement cast-only string types (`uuid`, `date`, `time`/`timetz`, `timestamp`/`timestamptz`, `bytea`, `json`, `jsonb`): require `JsonValue::String` (coerce others to text); placeholder `Cast(<literal>)`.
- [x] 2.8 Implement `BindKind::Fallback`: stringify the JSON value (`to_string()` for non-string, take the inner for `String`); placeholder `Cast(<canonical-type-name>)`.
- [x] 2.9 Reject `JsonValue::Null` with the existing message; reject `Array`/`Object` (callers handle arrays before reaching `bind_value`).

## 3. Wiring through the SQL builder (Rust)

- [x] 3.1 Update `predicate_for(column_name, op, value, cast_suffix, params)` to also accept a `&ColumnTypeIndex` (or pre-resolved `BindKind`). For `ColumnRef::AnyColumn`, use `BindKind::Text`. For named, look up the kind; if missing, return `AppError::Validation { message: "filter references unknown column '<name>'" }`.
- [x] 3.2 In every call site of the old `json_to_param` inside `predicate_for` (single-bound binary, `In`/`NotIn`, `BETWEEN`), call `bind_value` with the correct `BindKind` and substitute the returned `PlaceholderTemplate` into the SQL fragment instead of the hardcoded `placeholder_for(idx)`.
- [x] 3.3 For pattern operators (`LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE`, `Contains`, `StartsWith`, `EndsWith`), force `BindKind::Text` regardless of the column type so the placeholder stays `$N` and the bind type is `String`.
- [x] 3.4 Update `compile_filter_tree` to build a `ColumnTypeIndex` from `&[Column]` once and pass it into `predicate_for`.
- [x] 3.5 Verify `build_select_sql` still compiles; the existing signature already passes `&[Column]` down so no upstream changes are needed.
- [x] 3.6 Confirm `postgres_count_table` reuses `compile_filter_tree` — same fix applies automatically. If it has its own column-fetch path, mirror the change.

## 4. Rust unit tests

- [x] 4.1 Update existing `compile_filter_tree` / `build_select_sql` golden tests in `data.rs` whose expected SQL is now `$N::<type>` instead of `$N` (uuid, timestamps, numeric, …). Keep text-column fixtures unchanged.
- [x] 4.2 Add a test: int4 column + integer JSON value → bound as `i32`, placeholder `$1`.
- [x] 4.3 Add a test: int8 column + integer JSON value → bound as `i64`, placeholder `$1`.
- [x] 4.4 Add a test: int4 column + JSON string `"20528"` → bound as `i32`, placeholder `$1`.
- [x] 4.5 Add a test: int4 column + JSON string `"abc"` → returns `AppError::Validation` with the `expected integer for column '…'` message; no SQL dispatched.
- [x] 4.6 Add a test: int4 column + value out of `i32` range → returns `AppError::Validation` mentioning out-of-range.
- [x] 4.7 Add a test: numeric column + JSON number `19.99` → SQL contains `$1::numeric`, bound as `String("19.99")`.
- [x] 4.8 Add a test: uuid column + JSON string → SQL contains `$1::uuid`, bound as `String`.
- [x] 4.9 Add a test: timestamptz column + JSON string with `BETWEEN` → SQL contains `$1::timestamptz AND $2::timestamptz`, both bound as `String`.
- [x] 4.10 Add a test: `IN` on int4 with `[200, 201, 204]` → SQL contains `($1, $2, $3)`, each bound as `i32`.
- [x] 4.11 Add a test: `Contains` on text column → SQL contains `ILIKE '%' || $1 || '%'` with no cast, parameter bound as `String`.
- [x] 4.12 Add a test: `any_column` `Contains` → column refs cast `::text`, parameter `String`, placeholder `$1`.
- [x] 4.13 Add a test: unknown column name in `filter_tree` → returns `AppError::Validation` with the `filter references unknown column '…'` message.
- [x] 4.14 Add a test: fallback path (e.g. `inet`) → SQL contains `$1::inet` with `String` bind.
- [x] 4.15 Add a test for the type normalizer: `varchar(255)`, `numeric(10,2)`, `timestamp(6) with time zone` all canonicalize correctly.
- [x] 4.16 Run `cargo test --manifest-path src-tauri/Cargo.toml -p argus -- modules::postgres::data::` and confirm all tests pass. (58 tests pass; whole-crate run: 193 pass.)

## 5. Frontend touch-up

- [x] 5.1 In `src/modules/postgres/data/filter-bar/ValueInput.tsx`, audit `parseScalar` to confirm both `numeric` (decimal) and `integer` categories return `number`, not `string`. Already correct: `parseScalar` returns `Number(raw)` when category is `numeric`, which covers integer and decimal columns per `categorize()` in `typeHelpers.ts`.
- [x] 5.2 In the corresponding `compileWhere.test.ts` (frontend) update any snapshot/golden whose SQL placeholder shape changed to `$1::<type>`. Confirmed no-op — `compileWhere` is the local SQL preview path that inlines literals, not the bound-parameter path. All 109 frontend tests pass unchanged.
- [ ] 5.3 Add a small frontend regression test (or extend an existing one) that types `"abc"` into an integer column's value field and asserts the surfaced error is the new "expected integer …" string. _Not done — covered server-side by Rust test 4.5; surfacing the message in a UI test would require mocking the IPC layer for an error path. Defer unless the user wants it._

## 6. Manual verification

- [x] 6.1 Run the app against the user's repro (`inventory.movement` with `product_id = 20528`) and confirm rows return.
- [x] 6.2 Verify a `uuid` column equality filter on a real table.
- [x] 6.3 Verify a `timestamptz BETWEEN` filter on a real table.
- [x] 6.4 Verify a `numeric` column `<` filter returns the expected rows.
- [x] 6.5 Verify an `IN` filter with three integer values on an `int4` column returns the union.
- [x] 6.6 Verify the Count rows button reports the same count as the visible page when no filter is applied, and a smaller count when a filter narrows the result.
- [x] 6.7 Verify the Activity log entry's `params` field reads cleanly for the new bind types (no `Box<dyn …>` ugliness, just the Debug form of the typed value).

_Manual verification confirmed by user (2026-05-07): all repro cases pass against the live database._

## 7. Cleanup

- [x] 7.1 Remove the obsolete comment block on top of the old `json_to_param` (the "implicit-cast where possible" claim) and replace with a one-liner describing `bind_value`'s contract.
- [x] 7.2 Run `cargo fmt` and `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`. `cargo fmt` applied to `data.rs`. `clippy` shows only pre-existing warnings outside this change (e.g. `too_many_arguments` on `build_select_sql` which had 8 args before this change too).
- [x] 7.3 Run frontend `pnpm typecheck` and `pnpm test` (or the project's equivalent commands). `pnpm typecheck` clean; `pnpm test:run` 109/109 pass.
- [x] 7.4 Update CHANGELOG / release notes as required by project convention. _N/A — no `CHANGELOG.md` in repo; OpenSpec change record is the documentation source of truth._
