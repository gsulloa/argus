## Why

Filtering a table through the structured filter bar fails with `error serializing parameter 0` whenever the targeted column is an `int4`/`int2`/`numeric` column and the user enters a number. Repro: opening `inventory.movement` and adding `product_id = 20528` builds the documented SQL but the bind fails before Postgres ever sees a query, leaving the user with an opaque error and no obvious workaround inside the structured UI.

The root cause is in `src-tauri/src/modules/postgres/data.rs::json_to_param` (line 194): JSON numbers are unconditionally bound as Rust `i64`, which `tokio-postgres` only accepts for `int8`/`bigint`. Postgres does **not** implicit-cast at the bind layer, contrary to the comment on lines 188–193. The same class of failure exists for `uuid`, `date`, `timestamptz`, `numeric`, and any other type whose JSON shape (string or number) does not directly match the column's expected `ToSql` implementation. The structured filter is unusable for the most common kind of column — integer foreign keys — which is a regression against the v1 promise of the data grid.

## What Changes

- Make filter parameter binding **column-type-aware** in the Rust backend. `json_to_param` (and its callers `predicate_for`, `compile_filter_tree`, `build_select_sql`) MUST receive the resolved Postgres column type for the named column and bind a Rust value compatible with that type.
- Map common Postgres types to the correct Rust bind type for `=`, `!=`, `<`, `<=`, `>`, `>=`, `In`, `NotIn`, `BETWEEN`, `LIKE`-family, `Contains`, `StartsWith`, `EndsWith`. Minimum coverage:
  - integer family: `int2` → `i16`, `int4` → `i32`, `int8` → `i64`
  - floating: `float4` → `f32`, `float8` → `f64`
  - exact numeric: `numeric` / `decimal` → bind as `&str` with `$n::numeric` cast suffix on the placeholder
  - boolean: `bool` → `bool`
  - text family: `text`, `varchar`, `bpchar`, `name`, `citext` → `String`
  - uuid: `uuid` → bind via `$n::uuid` placeholder cast (parameter remains `String`; reject malformed at validation time)
  - date/time: `date`, `time`, `timestamp`, `timestamptz` → bind via `$n::<type>` placeholder cast on `String`
  - `bytea`, `json`, `jsonb` → bind via `$n::<type>` placeholder cast on `String` (best-effort; columns of these types in `=` filters are rare)
  - any other type → fall back to `String` parameter with `$n::<column-type-name>` placeholder cast, so Postgres performs the conversion
- For the `any_column` branch (search across all columns), continue casting the **column** to `::text` (existing behavior). The parameter remains a plain string.
- For `LIKE`, `ILIKE`, `Contains`, `StartsWith`, `EndsWith` the parameter MUST always bind as `String`, regardless of the column's underlying type, since pattern matching is text-only. The existing SQL is already correct; only the bind type narrows.
- For `In` / `NotIn`, every element MUST bind with the same column-typed coercion as the `=` operator.
- For `BETWEEN`, both `min` and `max` MUST bind with the same column-typed coercion.
- Surface a clearer validation error when a value cannot be coerced to the column's type at parse time (e.g. user typed `"abc"` for an int column) instead of letting it through and failing as a Postgres serialization error.
- Add Rust unit tests covering: int2/int4/int8/float8/numeric/uuid/timestamp coercion, In/Between/NotIn arrays, mismatched value rejection, fallback for unknown types, any-column (text cast) preserved.
- Frontend stays largely as-is. `ValueInput.parseScalar` already returns `number` for numeric categories; verify it covers integer and decimal categories. No new IPC contract changes are required — the column list passed to `compile_filter_tree` already exists (lines 846–860 of `data.rs`).
- **Not in scope**: changing the JSON shape sent from frontend to Rust (we still send `JsonValue`); supporting array/range column filters; rich validation feedback in the UI beyond the existing toast.

## Capabilities

### New Capabilities

_None._ This is a bugfix to the existing `postgres-data-grid` capability.

### Modified Capabilities

- `postgres-data-grid`: Tighten the `Query table command` and `Filter operator set` requirements to mandate that bound parameters are coerced to a Rust type compatible with the column's resolved Postgres data type, with an explicit fallback for types that have no native `ToSql` mapping.

## Impact

- **Code (Rust)**: `src-tauri/src/modules/postgres/data.rs`
  - `json_to_param` — new signature taking a column type hint
  - `predicate_for` — threads the column type from the resolved column list
  - `compile_filter_tree` / `build_select_sql` — already receive `&[Column]`, just propagate
  - any-column branch — unchanged (still binds string, casts column)
- **Code (Rust tests)**: extend `data.rs` tests around the existing SQL builder cases to assert both the placeholder shape (`$1` vs `$1::int4`) and the bound parameter type, plus new failure cases.
- **Code (TypeScript)**: minor — verify `parseScalar` returns `number` for both `numeric` (decimal) and `integer` categories; if it currently routes decimals through `Number(raw)`, no change needed. Add a regression test in `compileWhere.test.ts` if the SQL shape changes for any operator.
- **Specs**: delta on `postgres-data-grid` to add a `Type-aware parameter binding` requirement.
- **Activity log**: no shape change. The `params` field already Debug-formats bound values; with proper types it just becomes more correct.
- **APIs / IPC**: no contract change. `postgres_query_table` and `postgres_count_table` keep their existing payloads.
- **Risk**: low. The change narrows binding types; for any unsupported column type we fall back to `$n::<type-name>` text cast which is what we documented in the original comment but never actually implemented.
