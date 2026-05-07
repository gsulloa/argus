## ADDED Requirements

### Requirement: Type-aware structured filter parameter binding

When `postgres_query_table` (and `postgres_count_table`) compile a `filter_tree` to SQL, the backend SHALL bind every parameter using a Rust type compatible with the resolved Postgres data type of the referenced column. Binding MUST consult the column metadata fetched via `list_columns` for the same relation; the structured filter MUST NOT bind an integer JSON value as Rust `i64` for an `int4`/`int2` column, MUST NOT bind a string JSON value verbatim for a `uuid`/`date`/`timestamp`/`timestamptz`/`numeric`/`json`/`jsonb`/`bytea` column without a placeholder cast, and MUST NOT propagate `tokio_postgres` `error serializing parameter N` errors that originate purely from a Rust↔Postgres type-name mismatch.

The minimum supported mapping (Postgres column type → Rust bind type, placeholder shape) MUST be:

- `smallint`/`int2` → `i16`, placeholder `$N`
- `integer`/`int`/`int4` → `i32`, placeholder `$N`
- `bigint`/`int8` → `i64`, placeholder `$N`
- `real`/`float4` → `f32`, placeholder `$N`
- `double precision`/`float8` → `f64`, placeholder `$N`
- `numeric`/`decimal` → `String`, placeholder `$N::numeric`
- `boolean`/`bool` → `bool`, placeholder `$N`
- `text`/`character varying`/`varchar`/`character`/`bpchar`/`name`/`citext` → `String`, placeholder `$N`
- `uuid` → `String`, placeholder `$N::uuid`
- `date` → `String`, placeholder `$N::date`
- `time without time zone` → `String`, placeholder `$N::time`
- `time with time zone` → `String`, placeholder `$N::timetz`
- `timestamp without time zone` → `String`, placeholder `$N::timestamp`
- `timestamp with time zone` → `String`, placeholder `$N::timestamptz`
- `bytea` → `String`, placeholder `$N::bytea`
- `json` → `String`, placeholder `$N::json`
- `jsonb` → `String`, placeholder `$N::jsonb`

For any column data type not listed above, the backend MUST fall back to binding `String` with placeholder `$N::<canonical-type-name>` so Postgres performs the conversion. The canonical type name is the value returned by `information_schema.columns.data_type` (or equivalent), lowercased and with parameterized modifiers stripped (e.g. `varchar(255)` → `varchar`).

For the pattern operators (`LIKE`, `NOT LIKE`, `ILIKE`, `NOT ILIKE`, `Contains`, `StartsWith`, `EndsWith`), parameters MUST always bind as Rust `String` with a plain `$N` placeholder regardless of the column type — the column reference itself is unchanged from today's behavior. The frontend MUST continue to surface these operators only on text-family columns.

For the `any_column` branch, parameters MUST continue to bind as Rust `String` with a plain `$N` placeholder; the column itself is cast to `::text` per the existing requirement.

For `IN` / `NOT IN`, every array element MUST bind with the same column-typed coercion as `=`. For `BETWEEN`, both `min` and `max` MUST bind with the same column-typed coercion as `=`.

JSON-shape validation MUST run before boxing. If a value cannot be coerced to the column's bind type, the backend MUST return `AppError::Validation { message: "expected <kind> for column '<name>', got '<repr>'" }` where `<kind>` is one of `integer`, `number`, `numeric`, `boolean`, `string`, and `<repr>` is a short rendering of the offending JSON value. Numeric inputs MAY arrive as `JsonValue::String` (frontend escape hatch for very large numbers) and MUST be parsed with the target type's range check before binding. `JsonValue::Null` continues to be rejected with the existing "use IS NULL / IS NOT NULL" message.

If a `filter_tree` references a named column that does not appear in the resolved column list for the relation, the backend MUST return `AppError::Validation { message: "filter references unknown column '<name>'" }` before dispatching SQL. The `any_column` ref is exempt (no name to resolve).

#### Scenario: Integer column with int4 binds as i32

- **WHEN** the user invokes `postgres.queryTable(id, "inventory", "movement", { limit: 200, offset: 0, filter_tree: { children: [{ kind: "condition", column: { kind: "named", name: "product_id" }, op: "=", value: 20528 }] } })` and `inventory.movement.product_id` is `int4`
- **THEN** the issued SQL contains `WHERE "product_id" = $1` with the parameter bound as Rust `i32(20528)`
- **AND** the query succeeds and returns the matching rows
- **AND** no `error serializing parameter` is raised

#### Scenario: Smallint column binds as i16

- **WHEN** the user filters `{ column: { kind: "named", name: "tier" }, op: "=", value: 3 }` on an `int2` column `tier`
- **THEN** the parameter is bound as Rust `i16(3)` and the query succeeds

#### Scenario: Bigint column binds as i64

- **WHEN** the user filters `{ column: { kind: "named", name: "id" }, op: "=", value: 9223372036854775000 }` on an `int8` column
- **THEN** the parameter is bound as Rust `i64`

#### Scenario: UUID column receives a placeholder cast

- **WHEN** the user filters `{ column: { kind: "named", name: "user_id" }, op: "=", value: "550e8400-e29b-41d4-a716-446655440000" }` on a `uuid` column
- **THEN** the issued SQL contains `WHERE "user_id" = $1::uuid` and the parameter is bound as Rust `String`
- **AND** Postgres parses the cast and the query succeeds

#### Scenario: Timestamptz column receives a placeholder cast

- **WHEN** the user filters `{ column: { kind: "named", name: "created_at" }, op: ">=", value: "2026-01-01T00:00:00Z" }` on a `timestamp with time zone` column
- **THEN** the issued SQL contains `WHERE "created_at" >= $1::timestamptz` and the parameter is bound as Rust `String`

#### Scenario: Numeric column binds via string with cast

- **WHEN** the user filters `{ column: { kind: "named", name: "price" }, op: "<", value: 19.99 }` on a `numeric(10,2)` column
- **THEN** the issued SQL contains `WHERE "price" < $1::numeric` and the parameter is bound as Rust `String("19.99")`
- **AND** the query succeeds and returns rows with `price` strictly less than `19.99`

#### Scenario: BETWEEN on a date column casts both bounds

- **WHEN** the user filters `{ column: { kind: "named", name: "due_date" }, op: "BETWEEN", value: { min: "2026-03-01", max: "2026-03-31" } }` on a `date` column
- **THEN** the issued SQL contains `WHERE "due_date" BETWEEN $1::date AND $2::date` with both parameters bound as Rust `String`

#### Scenario: IN on an integer column binds each element as i32

- **WHEN** the user filters `{ column: { kind: "named", name: "status_code" }, op: "In", value: [200, 201, 204] }` on an `int4` column
- **THEN** the issued SQL contains `WHERE "status_code" IN ($1, $2, $3)` and each parameter is bound as Rust `i32`

#### Scenario: ILIKE on a text column binds as plain string

- **WHEN** the user filters `{ column: { kind: "named", name: "description" }, op: "Contains", value: "argus" }` on a `text` column
- **THEN** the issued SQL contains `WHERE "description" ILIKE '%' || $1 || '%'` (no cast) and the parameter is bound as Rust `String("argus")`

#### Scenario: any_column search keeps text cast on column

- **WHEN** the user filters `{ column: { kind: "any_column" }, op: "Contains", value: "x" }`
- **THEN** the issued SQL casts every column reference to `::text` (existing behavior) and binds the parameter as Rust `String` with placeholder `$N`

#### Scenario: Mismatched value type returns a clear validation error

- **WHEN** the user invokes `postgres.queryTable` with `filter_tree: { children: [{ kind: "condition", column: { kind: "named", name: "product_id" }, op: "=", value: "abc" }] }` on an `int4` column
- **THEN** the command returns `AppError::Validation { message: "expected integer for column 'product_id', got 'abc'" }` and no SQL is dispatched

#### Scenario: Stringified large integer is accepted

- **WHEN** the user invokes `postgres.queryTable` with `value: "20528"` (string form) on an `int4` column
- **THEN** the parameter is parsed and bound as Rust `i32(20528)` and the query succeeds

#### Scenario: Out-of-range integer is rejected

- **WHEN** the user filters with `value: 99999999999` on an `int4` column (max `2147483647`)
- **THEN** the command returns `AppError::Validation` with a message indicating the value is out of range for the column type and no SQL is dispatched

#### Scenario: Unknown column in filter is rejected before SQL dispatch

- **WHEN** the user invokes `postgres.queryTable` with `filter_tree` referencing a column name that does not exist on the relation
- **THEN** the command returns `AppError::Validation { message: "filter references unknown column '<name>'" }` and no SQL is dispatched

#### Scenario: Unsupported column type falls back to placeholder cast

- **WHEN** the user filters `{ column: { kind: "named", name: "addr" }, op: "=", value: "192.168.1.1" }` on an `inet` column (not in the explicit mapping table)
- **THEN** the issued SQL contains `WHERE "addr" = $1::inet` with the parameter bound as Rust `String`
- **AND** Postgres parses the cast and the query succeeds

#### Scenario: Same coercion applies to count_table

- **WHEN** the user invokes `postgres.countTable` with the same `filter_tree` shape used in `postgres.queryTable`
- **THEN** the bound parameters and placeholder shapes match exactly what `postgres.queryTable` produces for the same filter
