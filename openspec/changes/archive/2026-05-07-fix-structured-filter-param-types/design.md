## Context

The structured filter pipeline in Argus today flows like this:

```
ValueInput.tsx (TS)        →  number | string | boolean
  → JSON over Tauri IPC    →  serde_json::Value
  → predicate_for() (Rust) →  json_to_param(&JsonValue)
  → Box<dyn ToSql + …>     →  client.query(&sql, &param_refs)
```

The frontend already preserves the user's intended Rust scalar type (it parses numeric inputs to `Number`, returns booleans as `bool`, etc.). The Tauri/serde boundary preserves JSON's coarse types (`Number`, `String`, `Bool`, `Null`). The breakage is in the last hop.

`json_to_param` (`src-tauri/src/modules/postgres/data.rs:194`) maps:

| JSON                   | Rust bind type | Postgres `ToSql` accepts |
| ---------------------- | -------------- | ------------------------ |
| `Number` (integer)     | `i64`          | `int8` only              |
| `Number` (float)       | `f64`          | `float8` only            |
| `String`               | `String`       | `text`/`varchar`/`bpchar`/`name` |
| `Bool`                 | `bool`         | `bool`                   |

`tokio-postgres` is **strict** about `ToSql` ↔ Postgres-type matching at bind time and does **not** apply implicit casts. The result: any column whose actual type is `int4` (the default for `INTEGER`), `int2`, `numeric`, `uuid`, `date`, `timestamptz`, `float4`, etc. fails with `error serializing parameter 0`. The reproducer in the bug report — `inventory.movement.product_id` is `int4` and the user typed `20528`, which `json_to_param` boxes as `i64` — is the textbook case.

We already fetch column metadata at execute time. `postgres_query_table` calls `list_columns()` (`data.rs:846`) and threads `&[Column]` into `build_select_sql` → `compile_filter_tree` → `predicate_for`. We have what we need; we just don't use it for binding.

Two additional facts shape the design:

1. The `any_column` filter branch already casts the **column** to `::text` in SQL. Parameters there are always strings; nothing changes.
2. The pattern operators (`LIKE`, `ILIKE`, `Contains`, `StartsWith`, `EndsWith`) require text on both sides. Even on a non-text column, the placeholder must bind as `String`. Today this would fail anyway because the column itself is not text — but in practice these operators are gated by the frontend to text columns (`Filter operator set` requirement). We will keep that gate and bind as `String`.

## Goals / Non-Goals

**Goals:**

- The repro case (`inventory.movement.product_id = 20528`) succeeds end-to-end and returns rows.
- All comparison operators (`=`, `!=`, `<`, `<=`, `>`, `>=`, `In`, `NotIn`, `BETWEEN`) work for the Postgres types listed in the proposal: `int2`, `int4`, `int8`, `float4`, `float8`, `numeric`, `bool`, `text`/`varchar`/`bpchar`/`name`/`citext`, `uuid`, `date`, `time`, `timestamp`, `timestamptz`, `bytea`, `json`, `jsonb`.
- Unsupported / unknown column types fall back to a `$n::<type-name>` cast on a `String` parameter so Postgres performs the conversion, instead of failing at bind time.
- Validation errors raised at parse time are clearer than `error serializing parameter 0` (e.g. "expected integer for column `product_id`, got string").
- No change to the Tauri command shapes, the activity-log payload, or the frontend filter tree JSON.

**Non-Goals:**

- Adding a typed filter representation to the IPC layer (continue using `JsonValue`).
- Range / array column filtering (`int4range`, `text[]`, etc.) — not currently supported, still not.
- UI changes to error toasts beyond surfacing the new Rust error verbatim.
- Rich type inference on `any_column` searches (still string + `::text` column cast).
- Changing how the SQL editor binds parameters (separate code path; out of scope).

## Decisions

### Decision 1: Column-typed binding via a `bind_value` helper

Replace `json_to_param(&JsonValue)` with `bind_value(&JsonValue, pg_type: &str) -> AppResult<BoundParam>` where `BoundParam` is:

```rust
struct BoundParam {
    /// Owned `ToSql` value of the Rust type matching the column.
    value: Box<dyn ToSql + Sync + Send>,
    /// SQL fragment for the placeholder. Either `"$N"` (no cast) or
    /// `"$N::<type>"` (Postgres-side cast). Caller substitutes `N`.
    placeholder_template: PlaceholderTemplate,
}

enum PlaceholderTemplate {
    Plain,                  // "$N"
    Cast(&'static str),     // "$N::<type>" — type is a Postgres type literal
}
```

Mapping table (canonical Postgres type names from `pg_catalog.format_type` / `data_type` in `information_schema.columns`):

| Postgres type (lowercased)                                  | JSON value | Rust bind type | Placeholder           |
| ----------------------------------------------------------- | ---------- | -------------- | --------------------- |
| `smallint`, `int2`                                          | Number     | `i16`          | `$n`                  |
| `integer`, `int`, `int4`                                    | Number     | `i32`          | `$n`                  |
| `bigint`, `int8`                                            | Number     | `i64`          | `$n`                  |
| `real`, `float4`                                            | Number     | `f32`          | `$n`                  |
| `double precision`, `float8`                                | Number     | `f64`          | `$n`                  |
| `numeric`, `decimal`                                        | Number/String | `String`    | `$n::numeric`         |
| `boolean`, `bool`                                           | Bool       | `bool`         | `$n`                  |
| `text`, `character varying`, `varchar`, `character`, `bpchar`, `name`, `citext` | String | `String` | `$n` |
| `uuid`                                                      | String     | `String`       | `$n::uuid`            |
| `date`                                                      | String     | `String`       | `$n::date`            |
| `time without time zone`, `time with time zone`             | String     | `String`       | `$n::time` / `$n::timetz` |
| `timestamp without time zone`                               | String     | `String`       | `$n::timestamp`       |
| `timestamp with time zone`                                  | String     | `String`       | `$n::timestamptz`     |
| `bytea`                                                     | String     | `String`       | `$n::bytea`           |
| `json`                                                      | String     | `String`       | `$n::json`            |
| `jsonb`                                                     | String     | `String`       | `$n::jsonb`           |
| _anything else_                                             | String     | `String`       | `$n::<verbatim type>` |

Numeric is bound as `String` because `tokio-postgres` does not implement `ToSql for rust_decimal::Decimal` without a feature flag we don't carry, and binding as `f64` loses precision. The `::numeric` cast lets Postgres parse the string.

**Rationale for the placeholder cast over typed binding for non-numeric types:** for types like `uuid`, `date`, `timestamptz`, the alternatives are (a) take a dependency on `uuid`/`chrono` features in `tokio-postgres`, (b) parse and bind as native Rust types, or (c) bind as text and let Postgres parse via `::cast`. Option (c) is the smallest, most uniform change, keeps the bound-params Debug-format readable in the activity log, and matches what an experienced Postgres user would type by hand. We accept that errors for malformed strings surface as Postgres errors (`invalid input syntax for type uuid: "abc"`) rather than Rust validation errors — those errors are clear enough.

**Rationale for typed bindings on integer/float/bool:** these types serialize cheaply as native Rust scalars, the `ToSql` impls are already in `tokio-postgres` core, and we already do this for `i64`/`f64`/`bool` today. Narrowing to `i32`/`i16`/`f32` is one additional `as` and one more arm of the match. No new dependencies.

**Alternatives considered:**

- _Bind everything as text + `$n::<type>` cast everywhere_. Uniform but doubles the SQL noise on the hot path (every integer comparison becomes `"id" = $1::int4`) and adds a tiny per-row parse cost. Not worth it for the simple cases.
- _Add a typed filter wire format (discriminated union from frontend)_. Bigger change, breaks the existing `compileWhere.test.ts` golden output, and we'd still need a Rust mapper. Defer; not needed for this fix.
- _Pass `Type::INT4` etc. via `tokio_postgres::types::Type` to `query_typed`_. `query_typed` is async-postgres-specific and changes the call shape; the `to_sql` mismatch happens regardless of the wire-protocol type hint. Skipped.

### Decision 2: Resolve column type once, at `compile_filter_tree`, by indexed lookup

`compile_filter_tree` already receives `columns: &[Column]`. Build a `HashMap<&str, &str>` of `name → data_type` once at the top of `compile_filter_tree` (case-sensitive — Postgres identifiers in our payload are already canonical because they came from `pg_attribute`). Pass this map (or a thin `ColumnTypeIndex` wrapper) into `predicate_for`. For `ColumnRef::AnyColumn`, the binding type is always `String` (text cast already on the column side); skip the lookup.

For named columns whose name is not in the map, return `AppError::Validation { message: "filter references unknown column 'xyz'" }`. This is a behavior tightening — today an unknown column passes through and fails at Postgres parse time with `42703`. Surfacing it earlier is strictly an improvement and matches what the spec implies (`filter_tree` is built from the resolved column list in the UI).

### Decision 3: Per-operator binding rules

| Operator | Bind type rule                                                  |
| -------- | --------------------------------------------------------------- |
| `=`, `!=`, `<`, `<=`, `>`, `>=` | `bind_value(value, column.data_type)` |
| `In`, `NotIn` | each array element bound the same as `=`                  |
| `BETWEEN`     | `min` and `max` both bound the same as `=`                |
| `LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE`, `Contains`, `StartsWith`, `EndsWith` | always bind as `String`, `Plain` placeholder. The frontend only surfaces these for text-family columns. If somehow invoked on a non-text column the SQL is the same as today; the column reference is unchanged. |
| `IS NULL`, `IS NOT NULL` | no value, no bind                              |

For pattern operators, we deliberately do **not** consult the column type. The values are user-typed wildcards; the column itself is text. No casts on the placeholder side.

### Decision 4: Coercion rules at bind time

`bind_value` performs JSON-shape validation **before** boxing:

- Integer types (`int2`/`int4`/`int8`): require `JsonValue::Number` with `as_i64()` succeeding and within range for the target Rust type. If `JsonValue::String`, attempt `parse::<i64>()` and check range; on failure return `AppError::Validation { message: "expected integer for column '<name>', got '<repr>'" }`. (Strings are accepted because the frontend may serialize large numbers as strings in some edge cases.)
- Float types: require `JsonValue::Number` (any) or `JsonValue::String` parseable to `f64`/`f32`.
- `numeric`/`decimal`: accept `JsonValue::Number` (stringify via `n.to_string()`) or `JsonValue::String` (use as-is). Cast on the placeholder.
- `bool`: require `JsonValue::Bool`.
- All other (text-bound) types: require `JsonValue::String`. `JsonValue::Number` is coerced to its `to_string()` representation as a courtesy (e.g. user filtered `id = 5` on a `uuid` column — we let Postgres parse and reject). Same for `JsonValue::Bool`.
- `JsonValue::Null` continues to be rejected with the existing message.

The error message format is fixed: `"expected <kind> for column '<name>', got '<got-repr>'"` so the frontend can pattern-match if it wants to.

### Decision 5: SQL shape changes

The SQL fragments emitted by `predicate_for` change in exactly one way: the placeholder string becomes `"$N"` or `"$N::<type>"` depending on the column's bind plan. Existing golden tests around `compile_filter_tree` SQL shape need updates for the typed cases; pure-text cases (the bulk of fixtures) emit the same `$1` as before.

The `binary_op_sql`, `Contains`/`StartsWith`/`EndsWith`, `In`/`NotIn`, `BETWEEN` SQL templates already accept arbitrary placeholder strings (`{placeholder}`, `{ph_min}`, etc.), so we only need to plumb the templated placeholder through, not rewrite the SQL builder.

## Risks / Trade-offs

- _Risk_: A column type we don't have a row for in the mapping table sneaks in (e.g. `tsvector`, `inet`, `int4range`). With the fallback `$n::<type-name>` cast on `String` bind, Postgres handles common cases (`inet`, `cidr`, `macaddr`). Range types and arrays will likely fail at SQL parse time with a clear Postgres error. → **Mitigation**: catch fall-through types in tests, and let unsupported types propagate the Postgres error message verbatim (no silent breakage, just an unhelpful but accurate error). Document the supported set in the spec.
- _Risk_: `data_type` from `information_schema.columns` for some types is verbose ("character varying", "timestamp without time zone"). Our match must use the canonical form. → **Mitigation**: a small normalizer that strips trailing modifiers (e.g. `(255)` for `varchar(255)`) and handles the verbose forms by lookup table. Tested.
- _Risk_: Numeric precision. Binding `numeric` via `String` round-trips through Postgres parsing; we lose typed comparison if Postgres has trailing-zero-aware compare semantics. → **Mitigation**: trailing zeros do not affect numeric equality in Postgres; this is fine. Document.
- _Risk_: Tightening the "unknown column" check to a Rust validation error changes one observable behavior. → **Mitigation**: the change is strictly more helpful (clearer error, no roundtrip to Postgres). No spec scenario today asserts the 42703 path; we adjust.
- _Risk_: Frontend regression where `parseScalar` returns a string for an integer column (e.g. user typed `"abc"`). Today this fails at Postgres bind. With the new path it fails at Rust validation with a better message. → **Mitigation**: add a frontend test that a non-numeric input on a numeric column shows the friendlier error.
- _Trade-off_: We do not adopt `chrono`/`uuid`/`rust_decimal` ToSql features. Pro: no new dep weight, no version coupling, smaller diff. Con: we lose typed validation for those columns, deferring to Postgres. We accept this; the validator on the column type fixes 90% of real-world cases (integer columns), and Postgres errors for malformed dates/UUIDs are clear.

## Migration Plan

1. Implement `bind_value` and the column-type index. Land the Rust changes behind no flag — this is a bugfix, behavior should change immediately for all users.
2. Update Rust unit tests in `data.rs` for the new placeholder shapes and bind types.
3. Verify the frontend `compileWhere.test.ts` golden output matches the new placeholder casts; update fixtures.
4. Manually verify on a real Postgres database: integer FK filter, uuid filter, timestamp BETWEEN, numeric column comparison, IN with mixed types.
5. No data migration. No feature flag. Rollback is `git revert`.

## Open Questions

- Do we want the friendlier error string (`"expected integer for column '…'"`) localized? Today no Argus error string is localized; defer.
- Should we also touch `postgres_count_table` in this change? It uses the same `compile_filter_tree` path so the fix propagates automatically; tests cover both. **Decision: yes, in scope, no extra spec delta needed beyond the shared requirement.**
