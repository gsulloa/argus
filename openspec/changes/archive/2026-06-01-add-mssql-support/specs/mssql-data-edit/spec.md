## ADDED Requirements

### Requirement: Edit operation payload shape

The MS SQL Server module SHALL define a typed `EditOp` payload accepted by the edit commands. `EditOp` MUST be a discriminated union with three variants:

- `{ kind: "update", pk: { [column: string]: JsonValue }, changes: { [column: string]: JsonValue } }` — `pk` carries the row's primary-key columns and their values; `changes` lists the columns being updated and the new values. `changes` MUST be non-empty. `pk` MUST be non-empty and MUST contain every column of the table's PK.
- `{ kind: "insert", values: { [column: string]: JsonValue } }` — `values` lists every column the user supplied. Columns omitted from `values` MUST NOT appear in the resulting `INSERT` so the database default (including `IDENTITY`) fires.
- `{ kind: "delete", pk: { [column: string]: JsonValue } }` — `pk` MUST be non-empty and MUST contain every column of the table's PK.

JSON values MUST be carried verbatim and bound as MS SQL Server parameters via `@P1, @P2, ...` named-positional placeholders (never interpolated into SQL). The backend MUST validate the shape and reject malformed payloads with `AppError::Validation` BEFORE opening any transaction.

Every `update` and `delete` op MUST produce a non-empty `WHERE` clause. If validation produces an empty WHERE for any reason, the op MUST be rejected with `AppError::Validation` BEFORE any SQL is dispatched, to prevent full-table mutations.

#### Scenario: Update without changes is rejected

- **WHEN** the frontend sends `{ kind: "update", pk: { id: 1 }, changes: {} }`
- **THEN** the command returns `AppError::Validation` with a message naming the offending op index
- **AND** no SQL is dispatched

#### Scenario: Update missing a PK column is rejected

- **WHEN** the table's PK is `(tenant_id, user_id)` and the frontend sends `{ kind: "update", pk: { user_id: 7 }, changes: { name: "x" } }`
- **THEN** the command returns `AppError::Validation` with a message naming the missing PK columns
- **AND** no SQL is dispatched

#### Scenario: Update on unknown column is rejected

- **WHEN** the frontend sends `{ kind: "update", pk: { id: 1 }, changes: { not_a_column: "x" } }`
- **THEN** the command returns `AppError::Validation` whose message names the unknown column
- **AND** no SQL is dispatched

#### Scenario: Insert with omitted columns relies on database defaults

- **WHEN** the frontend sends `{ kind: "insert", values: { name: "ana" } }` against a table whose `id` column is declared `INT IDENTITY(1,1)`
- **THEN** the issued SQL is `INSERT INTO [schema].[rel] ([name]) OUTPUT INSERTED.* VALUES (@P1);` with the single bound parameter `"ana"`
- **AND** the response carries the inserted row including the server-assigned `id` from `OUTPUT INSERTED.*`

#### Scenario: Delete missing PK column is rejected

- **WHEN** the table's PK is `(tenant_id, user_id)` and the frontend sends `{ kind: "delete", pk: { user_id: 7 } }`
- **THEN** the command returns `AppError::Validation`
- **AND** no SQL is dispatched

#### Scenario: Empty WHERE on update is rejected pre-dispatch

- **WHEN** validation somehow yields zero PK predicates for an `update` op (e.g. all PK values resolved to absent)
- **THEN** the op MUST be rejected with `AppError::Validation` BEFORE any SQL is dispatched
- **AND** no `UPDATE` lacking a `WHERE` clause is ever sent to MS SQL Server

### Requirement: Primary key lookup command

The MS SQL Server module SHALL expose a Tauri command `mssql_table_primary_key(connection_id, schema, relation, origin?)` that returns `{ columns: string[] | null, identity_column: string | null }`. `columns` MUST list the PK columns in their declared `key_ordinal` order, or be `null` when the relation has no primary key. `identity_column` MUST be the name of the column whose `sys.columns.is_identity = 1`, or `null` when no such column exists. SQL Server permits at most one `IDENTITY` column per table, so the field is a single string or `null` (never an array).

The command MUST query `sys.indexes` joined with `sys.index_columns` and `sys.columns` (filtered by `is_primary_key = 1`) to recover the PK columns in `key_ordinal` order, and `sys.columns.is_identity` for the IDENTITY flag. The command MUST acquire a connection from the pool registry, MUST honor the same read-only-aware path used by `mssql_query_table`, MUST apply a 5 second timeout, and MUST emit one `argus:activity-log` event before returning with `kind: "list_table_extras"` and `metric: { kind: "items", value: <pk_column_count + (identity_column ? 1 : 0), null treated as 0> }`.

#### Scenario: Table with simple PK and IDENTITY

- **WHEN** the frontend invokes `mssql_table_primary_key(id, "dbo", "users")` against a table `users` whose `id` column is `INT IDENTITY(1,1) PRIMARY KEY`
- **THEN** the response is `{ columns: ["id"], identity_column: "id" }`

#### Scenario: Table with composite PK and no IDENTITY

- **WHEN** the frontend invokes the command for a table whose PK is `(tenant_id, user_id)` declared in that order with no IDENTITY columns
- **THEN** the response is `{ columns: ["tenant_id", "user_id"], identity_column: null }`

#### Scenario: View has no PK

- **WHEN** the frontend invokes the command against an object whose `TABLE_TYPE` is `VIEW`
- **THEN** the response is `{ columns: null, identity_column: null }`

#### Scenario: Table with PK but no IDENTITY

- **WHEN** the table's PK is `(uuid)` declared `UNIQUEIDENTIFIER NOT NULL PRIMARY KEY` with no IDENTITY column
- **THEN** the response is `{ columns: ["uuid"], identity_column: null }`

### Requirement: Edit-SQL builder

The MS SQL Server module SHALL implement a pure builder `build_edit_sql(schema, relation, op, columns, pk_columns, use_output)` that returns `{ sql: string, params: Vec<BoundParam> }`. The builder MUST:

- Quote `schema` and `relation` using square brackets, doubling any embedded `]` (`a]b` → `[a]]b]`).
- Quote every column name with square brackets using the same escaping rule.
- Bind every value as `@P1, @P2, ...` named-positional parameters in left-to-right SQL order — never interpolate values into SQL.
- For `update` with `use_output = true`: emit `UPDATE [schema].[relation] SET [c1] = @P1, [c2] = @P2, ... OUTPUT INSERTED.* WHERE [pk1] = @PN AND [pk2] = @PN+1;`. The order of `SET` columns MUST match the iteration order of `changes` (BTreeMap, alphabetical) and MUST be deterministic across runs.
- For `insert` with `use_output = true`: emit `INSERT INTO [schema].[relation] ([c1], [c2], ...) OUTPUT INSERTED.* VALUES (@P1, @P2, ...);`. Columns omitted from `values` MUST NOT appear in the column list or values list.
- For `delete` with `use_output = true`: emit `DELETE FROM [schema].[relation] OUTPUT DELETED.* WHERE [pk1] = @P1 AND [pk2] = @P2;`.
- When `use_output = false` (degradation path, see "Trigger degradation"): omit the `OUTPUT` clause and emit plain `UPDATE` / `INSERT` / `DELETE` statements.

The builder MUST reuse the type-binding pipeline (see "Type binding for edit values") to coerce JSON values for each column based on its declared `DATA_TYPE`. All bind-validation errors (e.g. value out of range, malformed integer string, structured JSON for non-string column) MUST surface as `AppError::Validation` from the builder, which the apply command propagates as a thrown error BEFORE opening any transaction.

#### Scenario: Update on text and integer columns emits bracket-quoted statement

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { name: "ana", email: "a@b.com" } }` against `[dbo].[users]` (id is `INT`, name is `NVARCHAR`, email is `NVARCHAR`) with `use_output = true`
- **THEN** the returned `sql` is `UPDATE [dbo].[users] SET [email] = @P1, [name] = @P2 OUTPUT INSERTED.* WHERE [id] = @P3;` (email/name in alphabetical order)
- **AND** `params[0]` is bound as `String("a@b.com")`, `params[1]` is bound as `String("ana")`, `params[2]` is bound as `i32(1)`

#### Scenario: Insert respects supplied columns only

- **WHEN** the builder is called with `insert { values: { name: "ana" } }` against `[dbo].[users]` (name is `NVARCHAR`, id is `INT IDENTITY`) with `use_output = true`
- **THEN** the returned `sql` is `INSERT INTO [dbo].[users] ([name]) OUTPUT INSERTED.* VALUES (@P1);`
- **AND** the IDENTITY `id` column is NOT included so the server assigns it

#### Scenario: Delete with composite integer PK uses two placeholders

- **WHEN** the builder is called with `delete { pk: { tenant_id: 5, user_id: 7 } }` (both `INT`) with `use_output = true`
- **THEN** the returned `sql` is `DELETE FROM [dbo].[t] OUTPUT DELETED.* WHERE [tenant_id] = @P1 AND [user_id] = @P2;`
- **AND** `params[0]` is bound as `i32(5)`, `params[1]` is bound as `i32(7)`

#### Scenario: Pathological identifier is escaped

- **WHEN** the builder is called against a relation literally named `we]ird`
- **THEN** the returned `sql` quotes it as `[we]]ird]` (standard bracket-doubling)

#### Scenario: NULL value binds as SQL NULL

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { age: null } }` (age is `INT`) with `use_output = true`
- **THEN** the returned `sql` contains `SET [age] = @P1`
- **AND** the bound parameter is the typed `Option::<i32>::None`, which `tiberius` serializes as SQL NULL

#### Scenario: Out-of-range integer is rejected at build time

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { count: 99999 } }` (count is `TINYINT`, range 0..255)
- **THEN** the builder returns `AppError::Validation` whose message names the column `"count"` and the type `"TINYINT"`
- **AND** no SQL is produced

#### Scenario: Structured JSON for a non-string column is rejected

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { name: {"x": 1} } }` (name is `NVARCHAR`)
- **THEN** the builder returns `AppError::Validation` whose message names the column `"name"` and the data type `"NVARCHAR"`
- **AND** no SQL is produced

#### Scenario: Insert that supplies an IDENTITY column value is rejected

- **WHEN** the builder is called with `insert { values: { id: 42, name: "ana" } }` against `[dbo].[users]` whose `id` column is `IDENTITY`
- **THEN** the builder returns `AppError::Validation` whose message names the column `"id"` and points the user to the SQL editor for `SET IDENTITY_INSERT [users] ON`
- **AND** no SQL is produced

#### Scenario: Degradation path omits OUTPUT clause

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { name: "ana" } }` and `use_output = false`
- **THEN** the returned `sql` is `UPDATE [dbo].[users] SET [name] = @P1 WHERE [id] = @P2;` (no `OUTPUT INSERTED.*`)

### Requirement: Type binding for edit values

The MS SQL Server module SHALL define a type-binding pipeline that maps each MS SQL Server column's declared `DATA_TYPE` to a coercion of the incoming JSON value into a Rust bind parameter. The pipeline mirrors the Postgres `binding.rs` approach. For each column type:

- **Integer family** (`TINYINT`, `SMALLINT`, `INT`, `BIGINT`): the JSON value MUST be coerced into `i32` (for `TINYINT`, `SMALLINT`, `INT`) or `i64` (for `BIGINT`). Numeric strings MUST be parsed; floats with a non-integral fractional part MUST be rejected. Range MUST be validated against the declared subtype: `TINYINT` is unsigned 0..255 in SQL Server (unlike MySQL signed −128..127); `SMALLINT` is −32768..32767; `INT` is −2^31..2^31-1; `BIGINT` is −2^63..2^63-1.
- **DECIMAL / NUMERIC**: the JSON value MUST be coerced into `bigdecimal::BigDecimal` parsed from a canonical decimal string (preserving precision; never via `f64` round-trip). If the JSON value is a number, the builder MUST serialize it using its canonical decimal form (no scientific notation) before parsing into `BigDecimal`.
- **MONEY / SMALLMONEY**: same as DECIMAL — bound as `bigdecimal::BigDecimal`. SQL Server accepts a decimal literal for both types.
- **FLOAT / REAL**: the JSON value MUST be coerced into `f64` and bound directly.
- **CHAR / VARCHAR / TEXT**: the JSON value MUST be coerced into an owned `String` and bound as `&str`. Length is validated by the server, surfacing as error 8152 (truncation).
- **NCHAR / NVARCHAR / NTEXT**: the JSON value MUST be coerced into an owned `String` and bound as `&str`. `tiberius` handles the UTF-16 conversion server-side.
- **BINARY / VARBINARY / IMAGE**: the JSON value MUST be a base64-encoded string. The builder MUST `base64::decode` it into `Vec<u8>` and bind the bytes directly. Decode failures MUST surface as `AppError::Validation` naming the column.
- **ROWVERSION** (a.k.a. `TIMESTAMP` in SQL Server): NOT writable — the builder MUST reject any edit on a ROWVERSION column with `AppError::Validation { message: "rowversion columns are read-only system types" }`. This is enforced even though the JSON shape might be a valid base64 string.
- **DATE**: the JSON value MUST be a string matching ISO 8601 `YYYY-MM-DD`, parsed into `chrono::NaiveDate` and bound directly.
- **DATETIME / DATETIME2 / SMALLDATETIME**: the JSON value MUST be a string matching ISO 8601 (`YYYY-MM-DD HH:MM:SS[.fffffff]` or `YYYY-MM-DDTHH:MM:SS[.fffffff]`), parsed into `chrono::NaiveDateTime` and bound directly.
- **TIME**: the JSON value MUST be a string matching `HH:MM:SS[.fffffff]`, parsed into `chrono::NaiveTime` and bound directly.
- **DATETIMEOFFSET**: the JSON value MUST be a string matching ISO 8601 with `±HH:MM` offset, parsed into `chrono::DateTime<FixedOffset>` and bound directly (preserving the offset, not normalizing to UTC).
- **UNIQUEIDENTIFIER**: the JSON value MUST be a string in canonical form (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`), parsed into `uuid::Uuid` and bound directly. Parse failures MUST surface as `AppError::Validation` naming the column.
- **XML**: the JSON value MUST be a string (raw XML text), bound as `&str`. SQL Server parses and validates server-side; XML errors surface as their native error codes (e.g. 9436).
- **JSON** (SQL Server 2025+): the JSON value MUST be serialized via `serde_json::to_string` and bound as `&str`. SQL Server parses server-side.
- **BIT**: the JSON value MUST be coerced into `bool` (`true` → 1, `false` → 0, numeric 0/1 also accepted). Other numeric values MUST be rejected. There is NO `TINYINT(1) → bool` convention in SQL Server; `BIT` is the canonical boolean type and `TINYINT` is unsigned 0..255.
- **IDENTITY** columns on `Insert`: REJECT with `AppError::Validation { message: "cannot insert into IDENTITY column [<col>]; use the SQL editor with SET IDENTITY_INSERT [<table>] ON" }`. The check is enforced regardless of the underlying type (typically `INT` or `BIGINT`).
- **GEOMETRY / GEOGRAPHY**: NOT editable in v1 — the builder MUST reject any edit on a spatial column with `AppError::Validation { message: "geometry/geography columns are not editable in v1; use the SQL editor" }`.
- **HIERARCHYID**: NOT editable in v1 — the builder MUST reject with `AppError::Validation { message: "hierarchyid columns are not editable in v1; use the SQL editor" }`.
- **SQL_VARIANT**: NOT editable in v1 — the builder MUST reject with `AppError::Validation { message: "sql_variant columns are not editable in v1; use the SQL editor" }`.
- **NULL** for any editable type: bound as the typed `Option::<T>::None` matching the column's bind kind, so `tiberius` emits a NULL of the right type.
- **Unknown / unrecognized types**: bound as `String` with no special wrapper; SQL Server coerces server-side. The builder MUST log a `warn!` line so unhandled types become visible.

#### Scenario: DECIMAL column binds via BigDecimal to preserve precision

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { amount: 12345.6789 } }` (amount is `DECIMAL(18,4)`)
- **THEN** the bound parameter for `amount` is `BigDecimal("12345.6789")`
- **AND** the JSON number is NOT round-tripped through `f64`

#### Scenario: BINARY column expects base64 and decodes before bind

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { payload: "aGVsbG8=" } }` (payload is `VARBINARY(MAX)`)
- **THEN** the bound parameter is `Vec<u8>([104, 101, 108, 108, 111])` (the bytes of `"hello"`)

#### Scenario: BINARY column rejects non-base64 input

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { payload: "not base 64!!!" } }` (payload is `VARBINARY`)
- **THEN** the builder returns `AppError::Validation` whose message names the column `"payload"`
- **AND** no SQL is produced

#### Scenario: GEOMETRY column rejects all edits in v1

- **WHEN** the builder is called with any op touching a column whose `DATA_TYPE` is `GEOMETRY` (or `GEOGRAPHY`)
- **THEN** the builder returns `AppError::Validation` whose message points the user to the SQL editor
- **AND** no SQL is produced

#### Scenario: HIERARCHYID column rejects all edits in v1

- **WHEN** the builder is called with any op touching a column whose `DATA_TYPE` is `HIERARCHYID`
- **THEN** the builder returns `AppError::Validation` whose message points the user to the SQL editor
- **AND** no SQL is produced

#### Scenario: ROWVERSION column rejects all edits

- **WHEN** the builder is called with any op touching a column whose `DATA_TYPE` is `ROWVERSION` (or its alias `TIMESTAMP`)
- **THEN** the builder returns `AppError::Validation { message: "rowversion columns are read-only system types" }`
- **AND** no SQL is produced

#### Scenario: BIT coerces true/false to 1/0

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { active: true } }` (active is `BIT`)
- **THEN** the bound parameter for `active` is `bool(true)`

#### Scenario: UNIQUEIDENTIFIER requires canonical form

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { row_uuid: "550E8400-E29B-41D4-A716-446655440000" } }` (row_uuid is `UNIQUEIDENTIFIER`)
- **THEN** the bound parameter is `Uuid("550e8400-e29b-41d4-a716-446655440000")` (case-insensitive parse)

#### Scenario: DATETIMEOFFSET preserves the stored offset

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { event_at: "2025-01-15T10:30:00-05:00" } }` (event_at is `DATETIMEOFFSET`)
- **THEN** the bound parameter is `DateTime<FixedOffset>` carrying the `-05:00` offset (not normalized to UTC)

### Requirement: Apply command and transactional commit

The MS SQL Server module SHALL expose a Tauri command `mssql_apply_table_edits(connection_id, schema, relation, edits, origin?)` that executes all `edits` in a single MS SQL Server transaction. The command MUST:

1. Reject upfront with `AppError::Validation { message: "connection is read-only" }` if the pool's `read_only` flag is set. The check happens at the registry boundary BEFORE any SQL (including `BEGIN TRAN`) is dispatched.
2. Acquire a single connection from the pool and execute `BEGIN TRAN`.
3. For each `EditOp` in order, build the SQL via the shared builder (with `use_output` set per the trigger-degradation cache) and execute it with the bound parameters.
4. For each `update` and `insert` op, capture the returned `OUTPUT INSERTED.*` row directly from the same round-trip. For `delete` ops, capture the `OUTPUT DELETED.*` row to confirm the deletion. If the degradation path is in effect (see "Trigger degradation"), the apply MUST issue a follow-up `SELECT ... WHERE pk = ?` inside the same transaction to re-fetch the affected row.
5. On any error (validation, SQL, timeout, connection drop), execute `ROLLBACK` and return `AppError::Mssql { code, message, line, procedure, failed_op_index }` where `code` is the SQL Server numeric error code (or `None` for client-side errors), and `failed_op_index` is the 0-based index of the failing op. The buffer-level intent (the original `edits`) is NOT modified by the backend.
6. On success, execute `COMMIT` and return `{ applied: number, refreshed_rows: Array<{ pk: { [col: string]: JsonValue }, row: Array<CellValue> | null }>, deleted: Array<{ pk: { [col: string]: JsonValue } }>, errors: [], query_ms: number }`. `refreshed_rows` MUST contain one entry per `update` (the post-update row) and one entry per `insert` (the post-insert row including any server-assigned IDENTITY column); `delete` ops contribute to the `deleted` list instead.

The command MUST reuse the same 15s timeout + cancel-token pattern as `mssql_query_table`. The command MUST emit exactly one `argus:activity-log` event before returning, with `kind: "apply_table_edits"`, `connection_id: <id>`, `origin: <argument or "user">`, `sql: <concatenated SQL of all ops separated by "; ", truncated to 4000 chars>`, `params: null`, `metric: { kind: "items", value: <applied count on ok, attempted count on error> }`, and `status` matching the result. Frontend call sites that initiate the command in response to `⌘S` or the diff-preview confirm button MUST pass `origin: "user"`.

#### Scenario: All edits succeed in one transaction

- **WHEN** the frontend invokes the command with three edits (one update, one insert, one delete) and they all succeed
- **THEN** the database state reflects all three changes
- **AND** the response has `applied: 3`, `errors: []`, `refreshed_rows.length` equal to 2 (one update + one insert), and `deleted.length` equal to 1

#### Scenario: Mid-transaction failure rolls back everything

- **WHEN** the frontend invokes the command with five edits and the third fails with SQL Server error 2627 (`Violation of PRIMARY KEY constraint`)
- **THEN** the database state shows none of the five changes applied (full `ROLLBACK`)
- **AND** the command returns `AppError::Mssql { code: Some(2627), message: "<server message>", line: <line>, failed_op_index: 2 }`

#### Scenario: Rejection on read-only connection

- **WHEN** the frontend invokes the command against a connection whose pool is `read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }`
- **AND** no `BEGIN TRAN` statement is dispatched

#### Scenario: Activity-log event reflects the commit

- **WHEN** `mssql_apply_table_edits` succeeds with 5 ops
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "apply_table_edits"`, `status: "ok"`, `metric: { kind: "items", value: 5 }`, `origin: "user"`, `sql` containing the concatenated statements truncated to 4000 chars

#### Scenario: Activity-log event on failure reports attempted count

- **WHEN** `mssql_apply_table_edits` is invoked with 5 ops and the third fails
- **THEN** the emitted `argus:activity-log` event has `status: "err"` and `metric: { kind: "items", value: 5 }` (the attempted count)

### Requirement: OUTPUT clause refresh

For `INSERT`, `UPDATE`, and `DELETE` statements emitted by the apply command in the happy path, the builder MUST include an `OUTPUT` clause that returns the refreshed row in the same round-trip:

- `INSERT ... OUTPUT INSERTED.* VALUES (...)` — returns the inserted row including any server-assigned IDENTITY column value.
- `UPDATE ... SET ... OUTPUT INSERTED.* WHERE ...` — returns the post-update row. `INSERTED` is the SQL Server pseudo-table that carries the new values.
- `DELETE FROM ... OUTPUT DELETED.* WHERE ...` — returns the deleted row, used to confirm the deletion.

This eliminates the MySQL-style re-fetch round-trip in the happy path, achieving parity with Postgres' `RETURNING *`. Each `OUTPUT` row MUST be serialized through the same type-binding pipeline used by `mssql_query_table` so column shapes (cell envelopes, JSON pretty-printing, BINARY base64-encoding, UNIQUEIDENTIFIER canonicalization, DATETIMEOFFSET preservation, etc.) match the grid contract exactly.

#### Scenario: Insert returns server-assigned IDENTITY via OUTPUT

- **WHEN** the user inserts `{ name: "ana" }` against `users` whose `id` is `INT IDENTITY(1,1) PRIMARY KEY`
- **THEN** the issued SQL is `INSERT INTO [dbo].[users] ([name]) OUTPUT INSERTED.* VALUES (@P1);`
- **AND** the response `refreshed_rows[0].pk` is `{ id: <new server-assigned id> }`
- **AND** `refreshed_rows[0].row` matches the column-positional shape returned by `mssql_query_table`

#### Scenario: Update returns post-update row via OUTPUT INSERTED

- **WHEN** the user updates `{ pk: { id: 5 }, changes: { name: "ana" } }`
- **THEN** the issued SQL is `UPDATE [dbo].[users] SET [name] = @P1 OUTPUT INSERTED.* WHERE [id] = @P2;`
- **AND** no separate `SELECT` re-fetch is issued in the happy path
- **AND** the response `refreshed_rows[0]` carries the post-update row

#### Scenario: Update that changes a PK column returns the new PK via OUTPUT

- **WHEN** the user updates `{ pk: { id: 5 }, changes: { id: 6, name: "ana" } }`
- **THEN** the issued SQL is `UPDATE [dbo].[users] SET [id] = @P1, [name] = @P2 OUTPUT INSERTED.* WHERE [id] = @P3;` with params `[6, "ana", 5]`
- **AND** the response `refreshed_rows[0].pk` is `{ id: 6 }` (the new value, from `OUTPUT INSERTED.*`)

#### Scenario: Delete echoes deleted row via OUTPUT DELETED

- **WHEN** the user deletes `{ pk: { id: 5 } }`
- **THEN** the issued SQL is `DELETE FROM [dbo].[users] OUTPUT DELETED.* WHERE [id] = @P1;`
- **AND** the response `deleted` list contains `{ pk: { id: 5 } }`

### Requirement: Trigger degradation path

When a target table has triggers that violate the `OUTPUT` clause restrictions, SQL Server returns error 334 (`The target table 'X' of the OUTPUT clause cannot have any enabled triggers if the statement contains a DML statement without the INTO clause`). The apply command MUST handle this gracefully:

1. On encountering error 334 during the first op against a `(connection, schema.table)`, the apply MUST `ROLLBACK` the entire transaction.
2. Mark the `(connection, schema.table)` tuple as "degraded" in an in-memory cache scoped to the pool registry. The cache survives for the lifetime of the connection pool and is cleared on disconnect.
3. Retry the apply from scratch with `use_output = false` for every op against this table. The retry MUST open a fresh `BEGIN TRAN`.
4. For each `update` and `insert` op in the retry, after executing the mutation, issue a follow-up `SELECT * FROM [schema].[relation] WHERE pk = ?` inside the same transaction to re-fetch the affected row. The re-fetch rules mirror the MySQL pattern:
   - **Insert** with an `identity_column`: re-fetch using `SELECT * FROM [schema].[relation] WHERE [<identity_column>] = SCOPE_IDENTITY();`. `SCOPE_IDENTITY()` is connection-and-scope-scoped, so this is safe.
   - **Insert** without an `identity_column`: re-fetch using the supplied PK values from `values`. If any PK column is missing from `values`, the apply MUST fail with `AppError::Validation` naming the missing PK columns.
   - **Update**: re-fetch using the row's effective PK after the update. If any PK column appears in `changes`, the new value MUST be used in the `WHERE` clause; otherwise the original `pk` payload values MUST be used.
   - **Delete**: no re-fetch — echo the original `pk` under the `deleted` list.
5. Subsequent invocations against a cached-degraded `(connection, schema.table)` MUST skip the `OUTPUT` attempt entirely on the first try, going straight to the `use_output = false` + re-fetch path.

If the re-fetch returns zero rows (defensive case — the row was deleted by a concurrent connection between the mutation and the SELECT), the corresponding `refreshed_rows` entry MUST set `row: null` and the apply MUST still commit normally. The frontend treats `row: null` as "could not refresh — re-fetch the page".

#### Scenario: First edit on a triggered table hits error 334 and retries without OUTPUT

- **WHEN** the user applies an `update` against a table that has an `AFTER UPDATE` trigger and the table is not yet in the degraded cache
- **THEN** the apply issues `UPDATE [dbo].[t] SET [name] = @P1 OUTPUT INSERTED.* WHERE [id] = @P2;` first
- **AND** receives SQL Server error 334
- **AND** rolls back the transaction
- **AND** marks `(connection, "dbo.t")` as degraded
- **AND** retries with `UPDATE [dbo].[t] SET [name] = @P1 WHERE [id] = @P2;` followed by `SELECT * FROM [dbo].[t] WHERE [id] = @P1;` inside a fresh transaction
- **AND** the response carries the re-fetched row

#### Scenario: Subsequent edits on a degraded table skip the OUTPUT attempt

- **WHEN** `(connection, "dbo.t")` is already in the degraded cache and the user applies another `update`
- **THEN** the apply does NOT emit `OUTPUT INSERTED.*` on the first try
- **AND** issues `UPDATE [dbo].[t] SET [...] WHERE [...];` followed by a `SELECT * FROM [dbo].[t] WHERE pk = ?;` re-fetch inside the same transaction
- **AND** completes in one round-trip pair (no retry)

#### Scenario: Degraded insert without IDENTITY uses supplied PK for re-fetch

- **WHEN** the table is degraded and the user inserts `{ uuid: "abc-123", name: "ana" }` against a table with PK `(uuid)` and no IDENTITY column
- **THEN** the apply issues `INSERT INTO [dbo].[users] ([uuid], [name]) VALUES (@P1, @P2);` followed by `SELECT * FROM [dbo].[users] WHERE [uuid] = @P1;`
- **AND** the response `refreshed_rows[0].pk` is `{ uuid: "abc-123" }`

#### Scenario: Degraded insert with IDENTITY uses SCOPE_IDENTITY for re-fetch

- **WHEN** the table is degraded and the user inserts `{ name: "ana" }` against a table whose `id` is `INT IDENTITY` PK
- **THEN** the apply issues `INSERT INTO [dbo].[users] ([name]) VALUES (@P1);` followed by `SELECT * FROM [dbo].[users] WHERE [id] = SCOPE_IDENTITY();` inside the same transaction
- **AND** the response `refreshed_rows[0].pk` is `{ id: <new server-assigned id> }`

#### Scenario: Degraded insert without IDENTITY that omits the PK is rejected

- **WHEN** the table is degraded, the table has PK `(uuid)` and no IDENTITY column, and the user submits `insert { values: { name: "ana" } }` (uuid omitted)
- **THEN** the apply returns `AppError::Validation` naming the missing PK column `uuid` BEFORE any SQL is dispatched

#### Scenario: Degradation cache is cleared on disconnect

- **WHEN** the connection is disconnected and reconnected
- **THEN** the next edit against the previously-degraded table starts with `use_output = true` and re-discovers the degradation on its own

#### Scenario: Re-fetch finds zero rows on a concurrently-deleted row

- **WHEN** a re-fetch in the degraded path returns zero rows (defensive case)
- **THEN** the corresponding `refreshed_rows` entry has `row: null`
- **AND** the transaction still commits normally

### Requirement: Read-only enforcement

`mssql_apply_table_edits` MUST reject any invocation against a connection whose pool's `read_only` flag is `true`, with `AppError::Validation { message: "connection is read-only" }`, BEFORE any SQL is dispatched. The check happens at the registry, NOT after `BEGIN TRAN`. The frontend MUST hide every edit affordance on read-only connections AND display a persistent banner in the bottom bar reading `Read-only connection — edits disabled`.

Defense-in-depth: should a slip-through occur (e.g. an Azure SQL replica routed by `ApplicationIntent=ReadOnly`), SQL Server surfaces error 3906 (`Failed to update database because the database is read-only`) or 3908 (`Could not run BEGIN TRANSACTION ... because this database is read-only`); the apply MUST treat these as `AppError::Mssql { code: Some(3906) }` / `AppError::Mssql { code: Some(3908) }` and rollback.

For Azure SQL connections where `read_only: true`, the pool registry MUST also set `ApplicationIntent=ReadOnly` on the underlying TDS connection config so the Azure gateway routes the connection to a read-only replica when one is available.

#### Scenario: Backend rejects edit attempt on read-only connection

- **WHEN** any caller invokes `mssql_apply_table_edits` for a read-only connection
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }`
- **AND** no `BEGIN TRAN`, `UPDATE`, `INSERT`, or `DELETE` statement is dispatched to the server

#### Scenario: Server-side read-only slip-through surfaces as 3906

- **WHEN** the pool flag is `false` but the underlying SQL Server returns error 3906 on the first statement after `BEGIN TRAN`
- **THEN** the apply returns `AppError::Mssql { code: Some(3906), failed_op_index: 0 }` after issuing `ROLLBACK`

#### Scenario: Azure SQL read-only pool sets ApplicationIntent

- **WHEN** a connection has `params.read_only: true` and the server is Azure SQL
- **THEN** the underlying `tiberius` `Config` sets `ApplicationIntent=ReadOnly`
- **AND** the Azure gateway routes the connection to a read-only replica when available

### Requirement: Error mapping

Failures inside the transaction MUST surface as `AppError::Mssql { code, message, line, procedure, failed_op_index }` where `code` is the SQL Server numeric error code (`i32`), NOT a SQLSTATE string. The apply command MUST recognize the following error codes as known cases and forward them verbatim (the message MAY also be enriched with context):

- `547` — generic constraint violation (FK, CHECK, default constraint).
- `2627` — unique-key violation (PRIMARY KEY or UNIQUE constraint).
- `2601` — duplicate key in a unique index (similar to 2627 but for unique indexes outside constraints).
- `515` — NOT NULL violation (`Cannot insert the value NULL into column ...`).
- `2628` — string or binary data right-truncation.
- `8152` — string or binary data right-truncation (modern error replacing 2628 in some paths).
- `8115` — numeric value out of range (arithmetic overflow).
- `241` — invalid date / time format (`Conversion failed when converting date and/or time from character string`).
- `242` — invalid date / time conversion (out-of-range datetime).
- `3906` — attempted write to a read-only database.
- `3908` — attempted `BEGIN TRANSACTION` on a read-only database.
- `334` — `OUTPUT` clause incompatible with triggers (handled by degradation path; surfaces only if degradation itself fails).
- `1205` — chosen as deadlock victim.
- `1222` — lock-wait timeout.
- `207` — invalid column name (should be caught by validation; defense-in-depth).
- `208` — invalid object name (table / view).

Unknown error codes MUST still be forwarded as-is with the original `code` and `message`. Client-side errors (no code available, e.g. connection closed mid-flight, cancellation) MUST set `code: None` and surface the underlying error message.

Cancellation via the in-protocol TDS Attention packet MUST surface as `AppError::Mssql { code: None, message: "query cancelled", ... }`.

#### Scenario: Duplicate PK on insert surfaces as 2627 with op index

- **WHEN** the user submits two inserts and the second collides with an existing PK
- **THEN** the apply returns `AppError::Mssql { code: Some(2627), failed_op_index: 1 }`
- **AND** the first insert is rolled back

#### Scenario: NOT NULL violation surfaces as 515

- **WHEN** the user inserts a row that omits a NOT NULL column with no default
- **THEN** the apply returns `AppError::Mssql { code: Some(515), failed_op_index: <i> }` after `ROLLBACK`

#### Scenario: Value too long surfaces as 8152

- **WHEN** the user updates a `VARCHAR(10)` column with a 50-character string
- **THEN** the apply returns `AppError::Mssql { code: Some(8152), failed_op_index: <i> }` after `ROLLBACK`

#### Scenario: Numeric overflow surfaces as 8115

- **WHEN** the user updates a `TINYINT` column with the value `999` (after validation somehow lets it through)
- **THEN** the apply returns `AppError::Mssql { code: Some(8115), failed_op_index: <i> }` after `ROLLBACK`

#### Scenario: Invalid date surfaces as 241

- **WHEN** the server rejects a date string with error 241
- **THEN** the apply returns `AppError::Mssql { code: Some(241), failed_op_index: <i> }` after `ROLLBACK`

#### Scenario: Cancellation surfaces with code: None

- **WHEN** the apply exceeds 15 seconds and the cancel token fires the TDS Attention packet
- **THEN** the apply returns `AppError::Mssql { code: None, message: "query cancelled", ... }` after `ROLLBACK`

#### Scenario: Unknown error code is forwarded verbatim

- **WHEN** the server returns an error code not in the recognized list (e.g. `50000` from a custom `RAISERROR`)
- **THEN** the apply returns `AppError::Mssql { code: Some(50000), message: <server message>, failed_op_index: <i> }`

### Requirement: Editable mode in the data viewer

The viewer tab `mssql-table-data` SHALL render in editable mode when the active connection's `params.read_only` is `false` AND the relation has a PK (or is being inserted into). The editable mode MUST satisfy the same UX rules as the Postgres / MySQL equivalent:

- Double-clicking a non-PK cell enters inline edit mode for that cell. PK cells of existing rows MUST remain read-only (changing a PK requires DELETE + INSERT, or an inspector edit that triggers the IDENTITY check).
- The inline editor's input type adapts to the column's SQL Server `DATA_TYPE`: text input for `VARCHAR`/`NVARCHAR`/`CHAR`/`NCHAR`, monospaced textarea for `TEXT`/`NTEXT`/`XML`/`JSON`, number input for integer and floating-point families, boolean select for `BIT`, ISO-string input for `DATE`/`DATETIME`/`DATETIME2`/`SMALLDATETIME`/`TIME`/`DATETIMEOFFSET`, canonical-form input for `UNIQUEIDENTIFIER`. `BINARY`/`VARBINARY`/`IMAGE`, `ROWVERSION`, `GEOMETRY`/`GEOGRAPHY`, `HIERARCHYID`, and `SQL_VARIANT` columns MUST display a "not editable inline" indicator and reject the double-click.
- IDENTITY columns of existing rows MUST be read-only (same as PK). IDENTITY columns on insert rows MUST be hidden / disabled with a tooltip explaining `SET IDENTITY_INSERT` is not supported in v1.
- Pressing `Tab` or `Enter` inside an inline editor commits the edit to the local buffer (NOT the database) and exits edit mode. Pressing `Escape` cancels the edit. Clicking outside the cell commits the edit to the buffer.
- An edited cell renders with a dirty highlight; a row marked for delete renders with strike-through and faded foreground; inserted rows appear at the top of the visible buffer and persist until commit.

#### Scenario: Double-click on non-PK cell enters edit mode

- **WHEN** the user double-clicks the `email` cell on a row whose PK is `id`
- **THEN** the cell renders an `<input>` with the current value selected
- **AND** the PK column does not become editable

#### Scenario: PK cell of existing row is not editable

- **WHEN** the user double-clicks the `id` cell of an existing row
- **THEN** no inline editor is rendered

#### Scenario: IDENTITY column on insert row is disabled

- **WHEN** the user clicks `Add row` and the table has an `id INT IDENTITY` column
- **THEN** the `id` cell of the new insert row is disabled (not editable) with a tooltip explaining the server assigns the value

#### Scenario: VARBINARY is not editable inline

- **WHEN** the user double-clicks a `VARBINARY(MAX)` cell
- **THEN** no inline editor opens
- **AND** the cell shows a `binary, not editable inline` tooltip

#### Scenario: ROWVERSION is not editable inline

- **WHEN** the user double-clicks a `ROWVERSION` cell
- **THEN** no inline editor opens
- **AND** the cell shows a `read-only system type` tooltip

#### Scenario: GEOMETRY is not editable inline

- **WHEN** the user double-clicks a `GEOMETRY` cell
- **THEN** no inline editor opens
- **AND** the cell shows a `not editable in v1` tooltip

#### Scenario: HIERARCHYID is not editable inline

- **WHEN** the user double-clicks a `HIERARCHYID` cell
- **THEN** no inline editor opens
- **AND** the cell shows a `not editable in v1` tooltip

### Requirement: Edit buffer and undo

The viewer SHALL maintain a per-tab in-memory edit buffer with the same operations and semantics as the Postgres / MySQL equivalent: `setCellEdit(rowKey, column, newValue)`, `markRowDelete(rowKey)`, `markRowUndelete(rowKey)`, `addInsertRow(values?)`, `undo()`, `clear()`, `commitSuccess(refreshedRows)`. The buffer MUST track every action in a stack so `undo()` removes exactly the most recent action. The buffer MUST NOT persist across app launches. The buffer MUST survive tab switches inside the same session.

When the user attempts to close a tab whose buffer has any dirty entries, the viewer MUST show a confirmation dialog reading `Discard N changes?`. Clicking `Cancel` keeps the tab open with the buffer intact.

#### Scenario: Undo reverts the last cell edit

- **WHEN** the user edits cell A then cell B, then presses `⌘Z`
- **THEN** cell B reverts to its server value (no longer dirty)
- **AND** cell A remains dirty

#### Scenario: Buffer survives tab switch

- **WHEN** the user has 3 dirty cells, switches to another tab, and returns
- **THEN** the 3 cells are still dirty and the buffer is intact

#### Scenario: Tab close with dirty buffer prompts confirmation

- **WHEN** the user attempts to close the tab while the buffer has any dirty entries
- **THEN** a confirmation dialog appears reading `Discard N changes?`
- **AND** clicking `Cancel` keeps the tab open with the buffer intact

### Requirement: Inspector edits reflect into grid

Editing a column inside the inspector pane SHALL mutate the same edit buffer as the grid cell editor. A change committed in the inspector MUST immediately re-render the corresponding grid cell with the dirty highlight, and a `⌘Z` undo MUST revert both the grid cell and the inspector field together. The inspector MUST disable editing on PK columns of existing rows, IDENTITY columns, BINARY/VARBINARY/IMAGE/ROWVERSION columns, spatial / HIERARCHYID / SQL_VARIANT columns, and any column on a read-only connection.

#### Scenario: Inspector edit shows up in the grid

- **WHEN** the user edits the `email` field in the inspector and tabs out
- **THEN** the corresponding grid cell for that row renders with the dirty highlight
- **AND** the displayed value in the grid matches the inspector value

#### Scenario: Undo reverts both inspector and grid

- **WHEN** the user edits the `email` field in the inspector, then presses `⌘Z`
- **THEN** both the inspector field and the grid cell revert to the server value

#### Scenario: Inspector disables PK fields on existing rows

- **WHEN** the user opens the inspector on an existing row
- **THEN** the PK column field is rendered read-only

#### Scenario: Inspector disables IDENTITY fields on insert rows

- **WHEN** the user opens the inspector on a new insert row and the table has an IDENTITY column
- **THEN** the IDENTITY column field is rendered read-only with a tooltip about `SET IDENTITY_INSERT`

### Requirement: Direct save flow

The viewer SHALL apply edits directly when the user presses `⌘S` (or activates the Save button) AND the buffer has at least one dirty entry. The viewer MUST:

- Invoke `mssql_apply_table_edits` with the buffer's serialized `EditOp[]` and `origin: "user"`.
- While the apply is in flight, disable the Save button and show a progress indicator.
- On success, clear the buffer and refresh the viewer (the simplest correct behavior is to re-fetch the first page).
- On `AppError::Mssql`, surface a non-blocking error banner above the grid containing the numeric code (when present), the message, the line number (when present), and the `failed_op_index` (e.g. `Op #2 failed: [2627] Violation of PRIMARY KEY constraint 'PK_users'`). The buffer MUST stay intact.
- On `AppError::Validation` (read-only / payload / IDENTITY on insert), surface the same banner with the validation message. The buffer MUST stay intact.

The viewer MUST NOT open a diff preview modal in v1.

#### Scenario: Cmd-S applies the buffer directly

- **WHEN** the user has any dirty entries and presses `⌘S`
- **THEN** `mssql_apply_table_edits` is invoked with the current `EditOp[]` and `origin: "user"`

#### Scenario: Cmd-S is no-op when buffer is clean

- **WHEN** the user presses `⌘S` with no dirty entries
- **THEN** no command is dispatched

#### Scenario: Apply success refreshes the viewer

- **WHEN** the apply succeeds with 1 update + 1 insert + 1 delete
- **THEN** the buffer is cleared and the viewer re-fetches its first page

#### Scenario: Op-failure banner shows numeric code and 1-based op index

- **WHEN** the apply returns `AppError::Mssql { code: Some(2627), failed_op_index: 2, message: "Violation of PRIMARY KEY constraint 'PK_users'" }`
- **THEN** a banner appears above the grid reading `Op #3 failed: [2627] Violation of PRIMARY KEY constraint 'PK_users'`
- **AND** the buffer is unchanged

### Requirement: Insert and delete affordances

The viewer SHALL render an `Add row` button in the bottom bar that, when activated, appends a new empty row to the buffer with kind `insert` and immediately enters inline edit mode on its first non-IDENTITY, non-PK editable column. The button MUST be hidden on read-only connections AND on relations whose `TABLE_TYPE` is `VIEW`. Tables with no explicit PK MAY still receive inserts; for those, the `Add row` button stays visible.

The viewer SHALL accept the `Backspace` (`⌫`) key when one or more rows are selected AND no inline editor is active. Pressing `⌫` MUST toggle the delete mark on every row currently in the selection range, following the same mixed-selection rules as the Postgres / MySQL equivalent (insert rows are removed; clean server rows are marked for delete; already-marked rows are undeleted). All toggles from a single `⌫` press MUST be applied as a single batched buffer action (one undo entry).

For relations with no PK, `⌫` MUST be no-op on server rows in the selection; `insert` rows in the selection MUST still be removable.

#### Scenario: Add row inserts an editable empty row

- **WHEN** the user clicks `Add row`
- **THEN** a new row appears at the top of the buffer with kind `insert`
- **AND** an inline editor opens on the first non-IDENTITY, non-PK editable column

#### Scenario: Add row hidden on a view

- **WHEN** the relation's `TABLE_TYPE` is `VIEW`
- **THEN** the `Add row` button is not rendered

#### Scenario: Backspace marks delete on the selection range

- **WHEN** the user selects 10 server rows (none deleted) and presses `⌫`
- **THEN** all 10 rows are marked for delete (rendered with strike-through)
- **AND** the buffer records a single undo entry for the bulk toggle

#### Scenario: Backspace toggles mixed selection in one action

- **WHEN** the user selects 10 rows where one is already marked for delete, one is an `insert` row, and the others are clean server rows
- **AND** presses `⌫`
- **THEN** the insert row is removed, the already-marked row is undeleted, and the rest are marked for delete
- **AND** the action is recorded as a single undo entry

#### Scenario: Backspace is no-op on read-only connection

- **WHEN** the user attempts the same action on a connection where `params.read_only: true`
- **THEN** no rows are marked for delete

### Requirement: Tables without a PK

When the loaded relation's `columns` (from `mssql_table_primary_key`) is `null`, the viewer SHALL keep `INSERT` enabled but SHALL disable `UPDATE` and `DELETE` affordances. The viewer MUST display a banner in the bottom bar stating that the relation has no primary key and that existing rows cannot be edited or deleted via Argus. Double-clicking an existing-row cell on such a relation MUST be a no-op.

#### Scenario: View has no PK so update/delete are off

- **WHEN** the user opens a view (`columns: null`)
- **THEN** the bottom bar shows a `no primary key` banner
- **AND** double-clicking a cell is a no-op
- **AND** the `Add row` button is hidden (because the relation is a view)

#### Scenario: Heap table without explicit PK still allows insert

- **WHEN** the user opens a heap table (no clustered index, no PRIMARY KEY) on a writable connection
- **THEN** the `Add row` button is rendered (insert is allowed)
- **AND** existing rows are read-only with the `no PK` banner visible
