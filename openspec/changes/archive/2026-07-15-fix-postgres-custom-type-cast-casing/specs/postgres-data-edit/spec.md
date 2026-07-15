## MODIFIED Requirements

### Requirement: Edit-SQL builder

The Postgres module SHALL implement a pure builder `build_edit_sql(schema, relation, op, columns, pk_columns)` that returns `{ sql: string, params: Vec<BoundParam> }`. The builder MUST:

- Quote `schema` and `relation` via the existing `quote_ident` helper.
- Quote every column name via `quote_ident`.
- Bind every value as a parameter (`$1`, `$2`, …) — never interpolate values into SQL.
- Use a type-aware binding strategy keyed off each column's declared `data_type` (as returned by `pg_catalog.format_type`). Built-in recognition MAY use a lowercase, modifier-free classification key, but any fallback or array cast target MUST preserve the exact trimmed `pg_catalog.format_type` output, including schema qualification, quoted identifiers, mixed case, and array suffixes. Four binding modes apply:
  - **Native-bind primitives** (`smallint`/`int2`, `integer`/`int4`, `bigint`/`int8`, `real`/`float4`, `double precision`/`float8`, `boolean`, `text`/`character varying`/`varchar`/`character`/`char`/`bpchar`/`name`/`citext`): the JSON value is parsed into the matching Rust primitive (`i16`/`i32`/`i64`/`f32`/`f64`/`bool`) or owned `String`, and bound directly. Placeholder is rendered as plain `$N` with no cast.
  - **Native-bind JSON** (`json`, `jsonb`): the JSON value is bound directly as `serde_json::Value` via tokio-postgres' `with-serde_json-1` feature. Placeholder is rendered as plain `$N` with no cast. Structured (`array`/`object`), scalar (number/string/bool), and `null` shapes are all accepted.
  - **Cast-from-text scalar types** (`uuid`, `numeric`/`decimal`, `date`, `time`, `time with time zone`/`timetz`, `timestamp`, `timestamp with time zone`/`timestamptz`, `bytea`, plus a fallback for any unrecognized non-array type): the JSON value is coerced to a `String` and bound as text. Placeholder is rendered as `$N::text::<type>`. The inner `::text` cast forces Postgres to infer `$N` as `text` (which is what tokio-postgres binds `String` to); the outer cast does the server-side conversion to the target type. For fallback types, `<type>` MUST be the exact catalog-formatted type rather than the normalized classification key. A single-cast `$N::<type>` would make Postgres infer `$N` as the target type directly (since the cast is identity on those types), and tokio-postgres would reject the bind with `error serializing parameter N`.
  - **One-dimensional array types** (any exact catalog type ending in `[]`): the edit value MUST be accepted as either a JSON array or a string containing a JSON array. For non-JSON element types, top-level string elements remain strings, numbers and booleans use their canonical textual representation, and nested arrays/objects are rejected. Precision-sensitive built-in arrays (`bigint`/`int8`, `bigserial`/`serial8`, `numeric`/`decimal`, and `money`) MUST reject JSON number elements and require JSON strings so JavaScript parsing cannot silently round a value before the edit reaches the backend. For `json[]` and `jsonb[]`, every non-null element MUST instead be serialized as complete JSON text, so string elements retain their JSON quotes and structured object/array elements remain valid JSON. In both modes, JSON `null` becomes a SQL `NULL` array element. The resulting `Vec<Option<String>>` MUST bind as a native `text[]`, and the placeholder MUST render as `$N::text[]::<exact-array-type>` so PostgreSQL performs the element-wise cast. Empty arrays MUST be accepted. Malformed JSON, JSON that is not an array, an unquoted precision-sensitive number, or structured elements for a non-JSON target MUST return `AppError::Validation` naming the column and declared type.
  - JSON `null` MUST bind as the typed `Option::<T>::None` for the column's bind kind (e.g. `Option::<i32>::None` for `integer`, `Option::<serde_json::Value>::None` for `jsonb`, `Option::<String>::None` for `uuid`, and `Option::<Vec<Option<String>>>::None` for an array). The placeholder shape MUST match the non-null case for the same kind.
  - JSON `array` and `object` values MUST be accepted when the column's bind kind is `json` or `jsonb` (where they bind natively as `serde_json::Value`). A JSON array MUST also be accepted for an array bind kind using the array conversion above. For every other kind, structured JSON values MUST be rejected with `AppError::Validation` naming the column and its data type.
- For `update`: emit `UPDATE <qualified> SET "c1" = <ph1>, "c2" = <ph2>, ... WHERE "pk1" = <ph_n> AND "pk2" = <ph_n+1>, ... RETURNING *`. The order of `SET` columns MUST match the iteration order of `changes` (BTreeMap, so alphabetical) and MUST be deterministic.
- For `insert`: emit `INSERT INTO <qualified> ("c1", "c2", ...) VALUES (<ph1>, <ph2>, ...) RETURNING *`. Columns omitted from `values` MUST NOT appear.
- For `delete`: emit `DELETE FROM <qualified> WHERE "pk1" = <ph1> AND "pk2" = <ph2> ...`.

UPDATE and INSERT statements MUST wrap their inner statement in `WITH _argus_r AS (<inner>) SELECT row_to_json(_argus_r)::text FROM _argus_r` so the apply command can decode the refreshed row through the existing data-module pipeline.

The builder MUST be reused by `postgres_apply_table_edits`. All bind-validation errors (e.g. value out of range, structured JSON for an incompatible column, malformed integer string, or malformed array JSON) MUST surface as `AppError::Validation` from the builder, which the apply command propagates as a thrown error before opening any transaction.

#### Scenario: Update on native-bind columns emits plain placeholders

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { name: "ana", email: "a@b.com" } }` against `"public"."users"` (id is `bigint`, name is `text`, email is `text`)
- **THEN** the returned `sql` contains `SET "email" = $1, "name" = $2 WHERE "id" = $3` (no `::<type>` casts because all three columns are native-bind kinds; `email`/`name` come first alphabetically before `id` in the WHERE clause numbering)
- **AND** `params[0]` is bound as `String("a@b.com")`, `params[1]` is bound as `String("ana")`, `params[2]` is bound as `i64(1)`

#### Scenario: Update on jsonb column binds serde_json::Value natively

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { metadata: {"a": 1} } }` against `"market"."product"` (id is `integer`, metadata is `jsonb`)
- **THEN** the returned `sql` contains `SET "metadata" = $1 WHERE "id" = $2` (no casts — both columns use native-bind paths)
- **AND** `params[0]` is bound as `serde_json::Value` `{"a": 1}`, `params[1]` is bound as `i32(1)`

#### Scenario: Insert respects supplied columns only

- **WHEN** the builder is called with `insert { values: { name: "ana" } }` against `"public"."users"` (name is `text`)
- **THEN** the returned `sql` contains `INSERT INTO "public"."users" ("name") VALUES ($1) RETURNING *` (no cast on a text column)

#### Scenario: Delete with composite integer PK uses plain placeholders

- **WHEN** the builder is called with `delete { pk: { tenant_id: 5, user_id: 7 } }` (both `integer`)
- **THEN** the returned `sql` is `DELETE FROM "public"."t" WHERE "tenant_id" = $1 AND "user_id" = $2`
- **AND** `params[0]` is bound as `i32(5)`, `params[1]` is bound as `i32(7)`

#### Scenario: Pathological identifier is escaped

- **WHEN** the builder is called against a relation named `we"ird`
- **THEN** the returned `sql` quotes it as `"we""ird"` (standard double-quote-doubling)

#### Scenario: NULL value on a native-bind column binds typed None

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { age: null } }` (age is `integer`)
- **THEN** the returned `sql` contains `SET "age" = $1` (plain placeholder)
- **AND** the bound parameter is `Option::<i32>::None` (NOT `Option::<String>::None`), which `tokio-postgres` accepts and serializes as a NULL of OID `int4`

#### Scenario: NULL value on a jsonb column binds typed None with no cast

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { metadata: null } }` (metadata is `jsonb`)
- **THEN** the returned `sql` contains `SET "metadata" = $1` (no cast — jsonb uses native binding)
- **AND** the bound parameter is `Option::<serde_json::Value>::None`

#### Scenario: NULL value on a cast-from-text column binds typed None with double cast

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { ext_id: null } }` (ext_id is `uuid`)
- **THEN** the returned `sql` contains `SET "ext_id" = $1::text::uuid`
- **AND** the bound parameter is `Option::<String>::None`

#### Scenario: Structured JSON value on a non-json column is rejected

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { name: {"x": 1} } }` (name is `text`)
- **THEN** the builder returns `AppError::Validation` whose message names the column `"name"` and the data type `"text"`
- **AND** no SQL is produced

#### Scenario: Out-of-range integer is rejected at build time

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { count: 999999999999 } }` (count is `smallint`)
- **THEN** the builder returns `AppError::Validation` whose message names the column `"count"` and the type `"smallint"`
- **AND** no SQL is produced

#### Scenario: Quoted mixed-case enum array preserves catalog identity

- **WHEN** `pg_catalog.format_type` reports `"default$default"."FeatureFlags"[]` for column `flags`, and the builder receives the canonical JSON string `["beta","dark-mode"]`
- **THEN** the returned SQL contains `"flags" = $1::text[]::"default$default"."FeatureFlags"[]`
- **AND** the cast target retains the exact schema, identifier quoting, mixed case, and array suffix
- **AND** the parameter is bound as a two-element `text[]`, never interpolated into SQL

#### Scenario: Direct JSON array payload uses the same array bind path

- **WHEN** the builder receives `changes: { flags: ["beta", null, "dark-mode"] }` for a column declared as `"default$default"."FeatureFlags"[]`
- **THEN** the parameter is bound as `Vec<Option<String>>` containing `Some("beta"), None, Some("dark-mode")`
- **AND** the placeholder remains `$1::text[]::"default$default"."FeatureFlags"[]`

#### Scenario: Empty and whole-NULL arrays remain distinct

- **WHEN** an empty JSON array is assigned to an array column
- **THEN** the builder binds an empty `text[]` and casts it to the exact declared array type
- **WHEN** JSON `null` is assigned to the same column
- **THEN** the builder binds `Option::<Vec<Option<String>>>::None` using the same array-cast placeholder

#### Scenario: Invalid array shapes fail before execution

- **WHEN** an array column receives malformed JSON, a JSON object, a scalar JSON value, or a nested array/object element for a non-JSON target type
- **THEN** the builder returns `AppError::Validation` naming the column and declared array type
- **AND** no SQL is produced and no transaction is opened

#### Scenario: JSON array columns preserve structured JSON elements

- **WHEN** a `jsonb[]` column receives `[{"a":1}, [1,2], "x", null]`
- **THEN** the binder produces text-array elements `{"a":1}`, `[1,2]`, `"x"`, and SQL `NULL`, preserving each non-null element as valid JSON text
- **AND** the placeholder renders as `$N::text[]::jsonb[]`

#### Scenario: Precision-sensitive numeric array values require strings

- **WHEN** a `numeric(38,9)[]` or `bigint[]` column receives a JSON number element
- **THEN** SQL construction fails with `AppError::Validation` naming the column and declared type and instructing the caller to use JSON strings
- **WHEN** the same exact numeric lexeme is quoted as a JSON string
- **THEN** that lexeme is preserved unchanged in the intermediate `text[]` value

#### Scenario: Quoted mixed-case scalar custom type preserves catalog identity

- **WHEN** an unrecognized scalar column has catalog type `"Tenant"."ExternalId"`
- **THEN** its placeholder renders as `$N::text::"Tenant"."ExternalId"`
- **AND** the binder does not emit the normalized but incorrect `"tenant"."externalid"`
