## MODIFIED Requirements

### Requirement: Edit-SQL builder

The Postgres module SHALL implement a pure builder `build_edit_sql(schema, relation, op, columns)` that returns `{ sql: string, params: Vec<BoundParam> }`. The builder MUST:

- Quote `schema` and `relation` via the existing `quote_ident` helper.
- Quote every column name via `quote_ident`.
- Bind every value as a parameter (`$1`, `$2`, …) — never interpolate values into SQL.
- Resolve each column's `BindKind` (via the shared `ColumnTypeIndex` over the `columns` slice) and emit each placeholder via that `BindKind`'s placeholder template — `$N` for native-bind types (int2/int4/int8/float4/float8/bool/text/json/jsonb) and `$N::text::<type>` for cast-from-text types (numeric/uuid/date/time/timetz/timestamp/timestamptz/bytea, plus typed-name fallback).
- For `update`: emit `UPDATE <qualified> SET "c1" = <placeholder1>, "c2" = <placeholder2>, ... WHERE "pk1" = <pk_placeholder1> AND ... RETURNING *`. The order of `SET` columns MUST be deterministic (sorted by column name).
- For `insert`: emit `INSERT INTO <qualified> ("c1", "c2", ...) VALUES (<placeholder1>, <placeholder2>, ...) RETURNING *`. Columns omitted from `values` MUST NOT appear.
- For `delete`: emit `DELETE FROM <qualified> WHERE "pk1" = <pk_placeholder1> AND "pk2" = <pk_placeholder2> ...`.

The builder MUST be reused by `postgres_apply_table_edits`.

**JSON / JSONB string normalization.** When a `json` or `jsonb` column receives a `JsonValue::String(s)` value, the bind step MUST attempt `serde_json::from_str(&s)` and bind the parsed JSON value rather than the raw string:

- If the parse succeeds, the bound value MUST be the parsed `JsonValue` (so a frontend-canonicalized `"{\"a\":1}"` becomes a jsonb object, not a jsonb string scalar).
- If the parse fails, the bind step MUST return `AppError::Validation` whose message names the column and quotes the parse error (e.g. `invalid JSON for column 'metadata': expected value at line 1 column 7`). The edit MUST NOT be sent to Postgres.
- A `JsonValue::Object`, `JsonValue::Array`, `JsonValue::Number`, `JsonValue::Bool`, or `JsonValue::Null` value for a json/jsonb column MUST be bound directly without re-parsing.

#### Scenario: Update produces parameterized SQL with type-aware placeholders

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { name: "ana", email: "a@b.com" } }` against `"public"."users"` (id is `bigint`, name is `text`, email is `text`)
- **THEN** the returned `sql` is `UPDATE "public"."users" SET "email" = $1, "name" = $2 WHERE "id" = $3 RETURNING *` (text and bigint both bind natively, columns alphabetized)

#### Scenario: Insert respects supplied columns only

- **WHEN** the builder is called with `insert { values: { name: "ana" } }` against `"public"."users"` (name is `text`)
- **THEN** the returned `sql` is `INSERT INTO "public"."users" ("name") VALUES ($1) RETURNING *`

#### Scenario: Delete with composite integer PK

- **WHEN** the builder is called with `delete { pk: { tenant_id: 5, user_id: 7 } }` (both `integer`)
- **THEN** the returned `sql` is `DELETE FROM "public"."t" WHERE "tenant_id" = $1 AND "user_id" = $2`

#### Scenario: Pathological identifier is escaped

- **WHEN** the builder is called against a relation named `we"ird`
- **THEN** the returned `sql` quotes it as `"we""ird"` (standard double-quote-doubling)

#### Scenario: NULL value with a non-text column binds typed None

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { age: null } }` (age is `integer`)
- **THEN** the returned `sql` contains `SET "age" = $1` and the bound parameter is `Option::<i32>::None`

#### Scenario: JSON-string input for a jsonb column is parsed before binding

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { metadata: "{\"a\":1}" } }` against a table where `metadata` is `jsonb`
- **THEN** the returned `sql` contains `SET "metadata" = $1` and the bound value, downcast to `serde_json::Value`, is `Value::Object({"a": 1})` — NOT `Value::String("{\"a\":1}")`
- **AND** Postgres receives a parsed jsonb object, so `jsonb_typeof(metadata)` returns `'object'`

#### Scenario: JSON-object input for a jsonb column is bound unchanged

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { metadata: {"a": 1} } }` against a jsonb column
- **THEN** the bound value, downcast to `serde_json::Value`, is `Value::Object({"a": 1})`
- **AND** the SQL placeholder is `$1` (no cast)

#### Scenario: Invalid JSON string for a jsonb column is rejected

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { metadata: "{not json}" } }` against a jsonb column
- **THEN** the builder returns `AppError::Validation` whose message contains `metadata` and a `serde_json` parse error description
- **AND** no SQL is produced

#### Scenario: Quoted JSON string input for a jsonb column round-trips as a jsonb string scalar

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { metadata: "\"hello\"" } }` against a jsonb column
- **THEN** the bound value, downcast to `serde_json::Value`, is `Value::String("hello")`
- **AND** Postgres stores the column as a jsonb string scalar `"hello"` (so `jsonb_typeof(metadata)` returns `'string'`)

#### Scenario: NULL for a jsonb column binds typed None

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { metadata: null } }` against a jsonb column
- **THEN** the bound value is `Option::<serde_json::Value>::None`
- **AND** the column reads back as SQL `NULL`
