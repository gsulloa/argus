# mysql-data-edit Specification

## Purpose
TBD - created by archiving change add-mysql-support. Update Purpose after archive.
## Requirements
### Requirement: Edit operation payload shape

The MySQL module SHALL define a typed `EditOp` payload accepted by the edit commands. `EditOp` MUST be a discriminated union with three variants:

- `{ kind: "update", pk: { [column: string]: JsonValue }, changes: { [column: string]: JsonValue } }` — `pk` carries the row's primary-key columns and their values; `changes` lists the columns being updated and the new values. `changes` MUST be non-empty. `pk` MUST be non-empty and MUST contain every column of the table's PK.
- `{ kind: "insert", values: { [column: string]: JsonValue } }` — `values` lists every column the user supplied. Columns omitted from `values` MUST NOT appear in the resulting `INSERT` so the database default (including `AUTO_INCREMENT`) fires.
- `{ kind: "delete", pk: { [column: string]: JsonValue } }` — `pk` MUST be non-empty and MUST contain every column of the table's PK.

JSON values MUST be carried verbatim and bound as MySQL parameters via `?` positional placeholders (never interpolated into SQL). The backend MUST validate the shape and reject malformed payloads with `AppError::Validation` BEFORE opening any transaction.

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

- **WHEN** the frontend sends `{ kind: "insert", values: { name: "ana" } }` against a table whose `id` column is declared `AUTO_INCREMENT`
- **THEN** the issued SQL is ``INSERT INTO `schema`.`rel` (`name`) VALUES (?);`` with the single bound parameter `"ana"`
- **AND** the backend re-fetches the inserted row via `LAST_INSERT_ID()` and returns it including the server-assigned `id`

#### Scenario: Delete missing PK column is rejected

- **WHEN** the table's PK is `(tenant_id, user_id)` and the frontend sends `{ kind: "delete", pk: { user_id: 7 } }`
- **THEN** the command returns `AppError::Validation`
- **AND** no SQL is dispatched

#### Scenario: Empty WHERE on update is rejected pre-dispatch

- **WHEN** validation somehow yields zero PK predicates for an `update` op (e.g. all PK values resolved to absent)
- **THEN** the op MUST be rejected with `AppError::Validation` BEFORE any SQL is dispatched
- **AND** no `UPDATE` lacking a `WHERE` clause is ever sent to MySQL

### Requirement: Primary key lookup command

The MySQL module SHALL expose a Tauri command `mysql_table_primary_key(connection_id, schema, relation, origin?)` that returns `{ columns: string[] | null, auto_increment_column: string | null }`. `columns` MUST list the PK columns in their declared ordinal order, or be `null` when the relation has no primary key. `auto_increment_column` MUST be the name of the column whose `INFORMATION_SCHEMA.COLUMNS.EXTRA` contains `auto_increment`, or `null` when no such column exists. MySQL permits at most one `AUTO_INCREMENT` column per table and it MUST be part of a key, so the field is a single string or `null` (never an array).

The command MUST query `INFORMATION_SCHEMA.KEY_COLUMN_USAGE` for the constraint named `PRIMARY` to recover the PK columns in `ORDINAL_POSITION` order, and `INFORMATION_SCHEMA.COLUMNS` for the `auto_increment` flag. The command MUST acquire a connection from the pool registry, MUST honor the same read-only-aware path used by `mysql_query_table`, MUST apply a 5 second timeout, and MUST emit one `argus:activity-log` event before returning with `kind: "list_table_extras"` and `metric: { kind: "items", value: <pk_column_count + (auto_increment_column ? 1 : 0), null treated as 0> }`.

#### Scenario: Table with simple PK and auto-increment

- **WHEN** the frontend invokes `mysql_table_primary_key(id, "shop", "users")` against a table `users` whose `id` column is `BIGINT AUTO_INCREMENT PRIMARY KEY`
- **THEN** the response is `{ columns: ["id"], auto_increment_column: "id" }`

#### Scenario: Table with composite PK and no auto-increment

- **WHEN** the frontend invokes the command for a table whose PK is `(tenant_id, user_id)` declared in that order with no auto-increment columns
- **THEN** the response is `{ columns: ["tenant_id", "user_id"], auto_increment_column: null }`

#### Scenario: View has no PK

- **WHEN** the frontend invokes the command against an object whose `TABLE_TYPE` is `VIEW`
- **THEN** the response is `{ columns: null, auto_increment_column: null }`

#### Scenario: Table with PK but no auto-increment

- **WHEN** the table's PK is `(uuid)` declared `CHAR(36) NOT NULL PRIMARY KEY` with no auto-increment
- **THEN** the response is `{ columns: ["uuid"], auto_increment_column: null }`

### Requirement: Edit-SQL builder

The MySQL module SHALL implement a pure builder `build_edit_sql(schema, relation, op, columns, pk_columns)` that returns `{ sql: string, params: Vec<BoundParam> }`. The builder MUST:

- Quote `schema` and `relation` using backticks, doubling any embedded backtick (`` ` `` → `` `` `` `` ``).
- Quote every column name with backticks using the same escaping rule.
- Bind every value as a `?` positional parameter — never interpolate values into SQL.
- For `update`: emit ``UPDATE `schema`.`relation` SET `c1` = ?, `c2` = ?, ... WHERE `pk1` = ? AND `pk2` = ?;``. The order of `SET` columns MUST match the iteration order of `changes` (BTreeMap, alphabetical) and MUST be deterministic across runs.
- For `insert`: emit ``INSERT INTO `schema`.`relation` (`c1`, `c2`, ...) VALUES (?, ?, ...);``. Columns omitted from `values` MUST NOT appear in the column list or values list.
- For `delete`: emit ``DELETE FROM `schema`.`relation` WHERE `pk1` = ? AND `pk2` = ?;``.

UPDATE, INSERT, and DELETE statements are emitted as **plain** statements (no `RETURNING` clause — MySQL does not support it for our target versions). Refresh of the row is performed by the apply command via a follow-up `SELECT` inside the same transaction; see "Refreshed-row re-fetch".

The builder MUST reuse the type-binding pipeline (see "Type binding for edit values") to coerce JSON values for each column based on its declared `DATA_TYPE`. All bind-validation errors (e.g. value out of range, malformed integer string, structured JSON for non-JSON column) MUST surface as `AppError::Validation` from the builder, which the apply command propagates as a thrown error BEFORE opening any transaction.

#### Scenario: Update on text and integer columns emits backtick-quoted statement

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { name: "ana", email: "a@b.com" } }` against `` `shop`.`users` `` (id is `BIGINT`, name is `VARCHAR`, email is `VARCHAR`)
- **THEN** the returned `sql` is ``UPDATE `shop`.`users` SET `email` = ?, `name` = ? WHERE `id` = ?;`` (email/name in alphabetical order)
- **AND** `params[0]` is bound as `String("a@b.com")`, `params[1]` is bound as `String("ana")`, `params[2]` is bound as `i64(1)`

#### Scenario: Update on JSON column wraps placeholder in CAST AS JSON

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { metadata: {"a": 1} } }` against `` `market`.`product` `` (id is `INT`, metadata is `JSON`)
- **THEN** the returned `sql` contains ``SET `metadata` = CAST(? AS JSON) WHERE `id` = ?``
- **AND** `params[0]` is bound as `String("{\"a\":1}")` (the JSON value re-serialized to a string)
- **AND** `params[1]` is bound as `i64(1)`

#### Scenario: Insert respects supplied columns only

- **WHEN** the builder is called with `insert { values: { name: "ana" } }` against `` `shop`.`users` `` (name is `VARCHAR`)
- **THEN** the returned `sql` is ``INSERT INTO `shop`.`users` (`name`) VALUES (?);``
- **AND** the auto-increment `id` column is NOT included so the server assigns it

#### Scenario: Delete with composite integer PK uses two placeholders

- **WHEN** the builder is called with `delete { pk: { tenant_id: 5, user_id: 7 } }` (both `INT`)
- **THEN** the returned `sql` is ``DELETE FROM `shop`.`t` WHERE `tenant_id` = ? AND `user_id` = ?;``
- **AND** `params[0]` is bound as `i64(5)`, `params[1]` is bound as `i64(7)`

#### Scenario: Pathological identifier is escaped

- **WHEN** the builder is called against a relation literally named `` we`ird ``
- **THEN** the returned `sql` quotes it as `` `we``ird` `` (standard backtick-doubling)

#### Scenario: NULL value binds as SQL NULL

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { age: null } }` (age is `INT`)
- **THEN** the returned `sql` contains ``SET `age` = ?``
- **AND** the bound parameter is the typed `Option::<i64>::None`, which the MySQL driver serializes as SQL NULL

#### Scenario: NULL on a JSON column still wraps in CAST AS JSON

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { metadata: null } }` (metadata is `JSON NULL`)
- **THEN** the returned `sql` contains ``SET `metadata` = CAST(? AS JSON)``
- **AND** the bound parameter is `Option::<String>::None`

#### Scenario: Out-of-range integer is rejected at build time

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { count: 999999999999 } }` (count is `SMALLINT`, range −32768..32767)
- **THEN** the builder returns `AppError::Validation` whose message names the column `"count"` and the type `"SMALLINT"`
- **AND** no SQL is produced

#### Scenario: Structured JSON for a non-JSON column is rejected

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { name: {"x": 1} } }` (name is `VARCHAR`)
- **THEN** the builder returns `AppError::Validation` whose message names the column `"name"` and the data type `"VARCHAR"`
- **AND** no SQL is produced

### Requirement: Type binding for edit values

The MySQL module SHALL define a type-binding pipeline that maps each MySQL column's declared `DATA_TYPE` to a coercion of the incoming JSON value into a Rust bind parameter. The pipeline mirrors the Postgres `binding.rs` approach. For each column type:

- **Integer family** (`TINYINT`, `SMALLINT`, `MEDIUMINT`, `INT`, `BIGINT`, including their `UNSIGNED` variants): the JSON value MUST be coerced into `i64` (or `u64` for unsigned variants where the value exceeds `i64::MAX`). Numeric strings MUST be parsed; floats with a non-integral fractional part MUST be rejected. Range MUST be validated against the declared subtype (e.g. `TINYINT` range −128..127, `TINYINT UNSIGNED` range 0..255).
- **DECIMAL / NUMERIC**: the JSON value MUST be coerced into a `String` (preserving precision; never via `f64` round-trip) and bound as a textual literal. MySQL parses the literal server-side. If the JSON value is a number, the builder MUST serialize it using its canonical decimal form (no scientific notation).
- **FLOAT / DOUBLE / REAL**: the JSON value MUST be coerced into `f64` and bound directly.
- **VARCHAR / CHAR / TEXT / TINYTEXT / MEDIUMTEXT / LONGTEXT**: the JSON value MUST be coerced into an owned `String` and bound directly. Length is validated by the server, surfacing as SQLSTATE `22001`.
- **JSON**: the JSON value MUST be serialized via `serde_json::to_string` and bound as a `String`. The placeholder MUST be wrapped in `CAST(? AS JSON)` in the emitted SQL so the server stores the value with the `JSON` type. Structured (`array`/`object`), scalar (number/string/bool), and `null` shapes are all accepted.
- **DATE**: the JSON value MUST be a string matching ISO 8601 `YYYY-MM-DD`, bound as a `String`. MySQL parses the literal.
- **DATETIME / TIMESTAMP**: the JSON value MUST be a string matching ISO 8601 (`YYYY-MM-DD HH:MM:SS[.ffffff]` or `YYYY-MM-DDTHH:MM:SS[.ffffff]Z?`), bound as a `String`.
- **TIME**: the JSON value MUST be a string matching `HH:MM:SS[.ffffff]` (with optional leading sign for negative intervals), bound as a `String`.
- **YEAR**: the JSON value MUST be coerced into `i64` in the range 1901..2155 (or 0), bound as integer.
- **BLOB / TINYBLOB / MEDIUMBLOB / LONGBLOB / BINARY / VARBINARY**: the JSON value MUST be a base64-encoded string. The builder MUST `base64::decode` it into `Vec<u8>` and bind the bytes directly. Decode failures MUST surface as `AppError::Validation` naming the column.
- **ENUM**: the JSON value MUST be a string. The builder MUST bind it directly; the server validates membership and rejects unknown labels with SQLSTATE `01000` / `HY000` (warning escalated to error per `sql_mode`).
- **SET**: the JSON value MUST be a string formatted as comma-separated set members (e.g. `"a,b"`). The builder MUST bind it directly.
- **BOOLEAN / BOOL** (aliases for `TINYINT(1)` in MySQL): the JSON value MUST be coerced into `i64` (`true` → `1`, `false` → `0`, numeric values pass through).
- **BIT(N)**: the JSON value MUST be either a non-negative integer (bound as `u64`) or a base64 string for `N > 64` (bound as bytes).
- **GEOMETRY** family (`GEOMETRY`, `POINT`, `LINESTRING`, `POLYGON`, etc.): NOT editable in v1 — the builder MUST reject any edit on a geometry column with `AppError::Validation { message: "geometry columns are not editable in v1" }`.
- **NULL** for any of the above: bound as the typed `Option::<T>::None` matching the column's bind kind, so the MySQL driver emits a NULL of the right type.
- **Unknown / unrecognized types**: bound as `String` with no `CAST(...)` wrapper; MySQL coerces server-side. The builder MUST log a `warn!` line so unhandled types become visible.

#### Scenario: DECIMAL column binds via string to preserve precision

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { amount: 12345.6789 } }` (amount is `DECIMAL(18,4)`)
- **THEN** the bound parameter for `amount` is `String("12345.6789")`
- **AND** the JSON number is NOT round-tripped through `f64`

#### Scenario: JSON column binds via CAST AS JSON

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { tags: ["red", "blue"] } }` (tags is `JSON`)
- **THEN** the emitted SQL contains ``SET `tags` = CAST(? AS JSON)``
- **AND** the bound parameter is `String("[\"red\",\"blue\"]")`

#### Scenario: BLOB column expects base64 and decodes before bind

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { payload: "aGVsbG8=" } }` (payload is `BLOB`)
- **THEN** the bound parameter is `Vec<u8>([104, 101, 108, 108, 111])` (the bytes of `"hello"`)

#### Scenario: BLOB column rejects non-base64 input

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { payload: "not base 64!!!" } }` (payload is `BLOB`)
- **THEN** the builder returns `AppError::Validation` whose message names the column `"payload"`
- **AND** no SQL is produced

#### Scenario: GEOMETRY column rejects all edits in v1

- **WHEN** the builder is called with any op touching a column whose `DATA_TYPE` is `GEOMETRY` (or `POINT`, `LINESTRING`, `POLYGON`, etc.)
- **THEN** the builder returns `AppError::Validation { message: "geometry columns are not editable in v1" }`
- **AND** no SQL is produced

#### Scenario: BOOLEAN coerces true/false to 1/0

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { active: true } }` (active is `TINYINT(1)`)
- **THEN** the bound parameter for `active` is `i64(1)`

### Requirement: Apply command and transactional commit

The MySQL module SHALL expose a Tauri command `mysql_apply_table_edits(connection_id, schema, relation, edits, origin?)` that executes all `edits` in a single MySQL transaction. The command MUST:

1. Reject upfront with `AppError::Validation { message: "connection is read-only" }` if the pool's `read_only` flag is set. The check happens at the registry boundary BEFORE any SQL (including `BEGIN`) is dispatched.
2. Acquire a single connection from the pool and execute `BEGIN`.
3. For each `EditOp` in order, build the SQL via the shared builder and execute it with the bound parameters.
4. After each successful `update` or `insert`, perform an in-transaction `SELECT` to re-fetch the affected row (see "Refreshed-row re-fetch"). For `delete` ops, no re-fetch is performed.
5. On any error (validation, SQL, timeout, connection drop), execute `ROLLBACK` and return `AppError::Mysql { code, message, failed_op_index }` where `code` is the SQLSTATE returned by the server (or `None` for client-side errors), and `failed_op_index` is the 0-based index of the failing op. The buffer-level intent (the original `edits`) is NOT modified by the backend.
6. On success, execute `COMMIT` and return `{ applied: number, refreshed_rows: Array<{ pk: { [col: string]: JsonValue }, row: Array<CellValue> | null }>, errors: [], query_ms: number }`. `refreshed_rows` MUST contain one entry per `update` (the post-update row) and one entry per `insert` (the post-insert row including any server-assigned auto-increment column); `delete` ops produce no `refreshed_rows` entry but their PK MUST be echoed back in the response under a parallel `deleted` list of `{ pk: { ... } }`.

The command MUST reuse the same 15s timeout + cancel-token pattern as `mysql_query_table`. The command MUST emit exactly one `argus:activity-log` event before returning, with `kind: "apply_table_edits"`, `connection_id: <id>`, `origin: <argument or "user">`, `sql: <concatenated SQL of all ops separated by "; ", truncated to 4000 chars>`, `params: null`, `metric: { kind: "items", value: <applied count on ok, attempted count on error> }`, and `status` matching the result. Frontend call sites that initiate the command in response to `⌘S` or the diff-preview confirm button MUST pass `origin: "user"`.

#### Scenario: All edits succeed in one transaction

- **WHEN** the frontend invokes the command with three edits (one update, one insert, one delete) and they all succeed
- **THEN** the database state reflects all three changes
- **AND** the response has `applied: 3`, `errors: []`, and `refreshed_rows.length` equal to 2 (one update + one insert; delete does not contribute)

#### Scenario: Mid-transaction failure rolls back everything

- **WHEN** the frontend invokes the command with five edits and the third fails with SQLSTATE `23000` (e.g. `Duplicate entry '5' for key 'PRIMARY'`)
- **THEN** the database state shows none of the five changes applied (full `ROLLBACK`)
- **AND** the command returns `AppError::Mysql { code: Some("23000"), message: "<server message>", failed_op_index: 2 }`

#### Scenario: Rejection on read-only connection

- **WHEN** the frontend invokes the command against a connection whose pool is `read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }`
- **AND** no `BEGIN` statement is dispatched

#### Scenario: Activity-log event reflects the commit

- **WHEN** `mysql_apply_table_edits` succeeds with 5 ops
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "apply_table_edits"`, `status: "ok"`, `metric: { kind: "items", value: 5 }`, `origin: "user"`, `sql` containing the concatenated statements truncated to 4000 chars

#### Scenario: Activity-log event on failure reports attempted count

- **WHEN** `mysql_apply_table_edits` is invoked with 5 ops and the third fails
- **THEN** the emitted `argus:activity-log` event has `status: "err"` and `metric: { kind: "items", value: 5 }` (the attempted count)

### Requirement: Refreshed-row re-fetch

Because MySQL does not support `RETURNING` for `INSERT`/`UPDATE`/`DELETE` in our target versions (MySQL 8.0+; MariaDB's `INSERT...RETURNING` is intentionally NOT relied upon for v1), the apply command MUST re-fetch each mutated row inside the same transaction (BEFORE `COMMIT`) using a follow-up `SELECT`. The re-fetch rules are:

- **Insert** with an `auto_increment_column`: after the `INSERT`, the backend MUST issue ``SELECT * FROM `schema`.`relation` WHERE `<auto_increment_column>` = LAST_INSERT_ID();``. `LAST_INSERT_ID()` is connection-scoped and unaffected by other connections, so this is safe.
- **Insert** WITHOUT an `auto_increment_column`: the backend MUST re-fetch using the supplied PK values from `values`. If any PK column is missing from `values` (e.g. the table has a non-auto-increment PK and the user did not supply it), the apply MUST fail with `AppError::Validation` naming the missing PK columns.
- **Update**: the backend MUST re-fetch using the row's effective PK after the update. If any PK column appears in `changes`, the **new** value MUST be used in the `WHERE` clause; otherwise the PK values from the original `pk` payload MUST be used. The composed `WHERE` clause MUST AND together all PK columns.
- **Delete**: no re-fetch — the response echoes the original `pk` under a `deleted` list.

Re-fetched rows MUST be serialized through the same type-binding pipeline used by `mysql_query_table` so column shapes (cell envelopes, JSON pretty-printing, BLOB base64-encoding, etc.) match the grid contract exactly. The re-fetch MUST happen inside the same transaction so the response is consistent (no other connection can interleave a write between the mutation and the SELECT).

If the re-fetch returns zero rows (e.g. the row was deleted by a concurrent connection between the `UPDATE` and the `SELECT` — impossible in `REPEATABLE READ` but defensive coding requires handling it), the `refreshed_rows` entry MUST set `row: null` and the apply MUST still commit normally. The frontend treats `row: null` as "could not refresh — re-fetch the page".

#### Scenario: Insert on auto-increment table re-fetches via LAST_INSERT_ID

- **WHEN** the user inserts `{ name: "ana" }` against `users` whose `id` is `BIGINT AUTO_INCREMENT PRIMARY KEY`
- **THEN** after the `INSERT`, the backend issues ``SELECT * FROM `shop`.`users` WHERE `id` = LAST_INSERT_ID();`` inside the same transaction
- **AND** the response `refreshed_rows[0].pk` is `{ id: <new server-assigned id> }`
- **AND** `refreshed_rows[0].row` matches the column-positional shape returned by `mysql_query_table`

#### Scenario: Insert on table without auto-increment re-fetches via supplied PK

- **WHEN** the user inserts `{ uuid: "abc-123", name: "ana" }` against `users` whose PK is `(uuid)` and there is no auto-increment column
- **THEN** the backend issues ``SELECT * FROM `shop`.`users` WHERE `uuid` = ?;`` with parameter `"abc-123"` inside the same transaction
- **AND** the response `refreshed_rows[0].pk` is `{ uuid: "abc-123" }`

#### Scenario: Insert on table without auto-increment that omits a PK column is rejected

- **WHEN** the user inserts `{ name: "ana" }` against `users` whose PK is `(uuid)` (non-auto-increment) and `uuid` is omitted from `values`
- **THEN** the apply returns `AppError::Validation` naming the missing PK column `uuid` BEFORE any SQL is dispatched

#### Scenario: Update that changes a PK column re-fetches using the new value

- **WHEN** the user updates `{ pk: { id: 5 }, changes: { id: 6, name: "ana" } }` against `users`
- **THEN** the backend issues ``UPDATE `shop`.`users` SET `id` = ?, `name` = ? WHERE `id` = ?;`` with params `[6, "ana", 5]`
- **AND** the backend re-fetches via ``SELECT * FROM `shop`.`users` WHERE `id` = ?;`` with param `[6]`
- **AND** the response `refreshed_rows[0].pk` is `{ id: 6 }`

#### Scenario: Update re-fetch uses original PK when PK is unchanged

- **WHEN** the user updates `{ pk: { id: 5 }, changes: { name: "ana" } }`
- **THEN** the re-fetch is ``SELECT * FROM `shop`.`users` WHERE `id` = ?;`` with param `[5]`

#### Scenario: Delete echoes PK without re-fetch

- **WHEN** the user deletes `{ pk: { id: 5 } }`
- **THEN** no `SELECT` is issued for that op
- **AND** the response `deleted` list contains `{ pk: { id: 5 } }`

#### Scenario: Re-fetch finds zero rows on a concurrently-deleted row

- **WHEN** a re-fetch after an `UPDATE` returns zero rows (defensive case)
- **THEN** the corresponding `refreshed_rows` entry has `row: null`
- **AND** the transaction still commits normally

### Requirement: Read-only enforcement

`mysql_apply_table_edits` MUST reject any invocation against a connection whose pool's `read_only` flag is `true`, with `AppError::Validation { message: "connection is read-only" }`, BEFORE any SQL is dispatched. The check happens at the registry, NOT after `BEGIN`. The frontend MUST hide every edit affordance on read-only connections AND display a persistent banner in the bottom bar reading `Read-only connection — edits disabled`.

Defense-in-depth: should a slip-through occur (e.g. a session-level read-only flag set by the server), MySQL surfaces SQLSTATE `25006` (`Cannot execute statement in a READ ONLY transaction`); the apply MUST treat this as a `AppError::Mysql { code: Some("25006") }` and rollback.

#### Scenario: Backend rejects edit attempt on read-only connection

- **WHEN** any caller invokes `mysql_apply_table_edits` for a read-only connection
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }`
- **AND** no `BEGIN`, `UPDATE`, `INSERT`, or `DELETE` statement is dispatched to the server

#### Scenario: Server-side read-only slip-through surfaces as 25006

- **WHEN** the pool flag is `false` but the underlying MySQL server returns `25006` on the first statement after `BEGIN`
- **THEN** the apply returns `AppError::Mysql { code: Some("25006"), failed_op_index: 0 }` after issuing `ROLLBACK`

### Requirement: Error mapping

Failures inside the transaction MUST surface as `AppError::Mysql { code, message, failed_op_index }` where `code` is the SQLSTATE returned by the server. The apply command MUST recognize the following SQLSTATEs as known cases and forward them verbatim (the message MAY also be enriched with context):

- `23000` — integrity constraint violation (PK conflict on Insert, FK violation, NOT NULL violation, UNIQUE violation). The response MUST report the failing op index so the UI can highlight the offending row.
- `22001` — string data right-truncation (value too long for column).
- `22003` — numeric value out of range.
- `22007` — invalid date/time format.
- `42S22` — column not found in field list (should be caught by validation; defense-in-depth).
- `25006` — attempted write in a read-only transaction.
- `70100` — query was interrupted (e.g. timeout cancellation).

Unknown SQLSTATEs MUST still be forwarded as-is with the original `code` and `message`. Client-side errors (no SQLSTATE available, e.g. connection closed mid-flight) MUST set `code: None` and surface the underlying error message.

#### Scenario: Duplicate PK on insert surfaces as 23000 with op index

- **WHEN** the user submits two inserts and the second collides with an existing PK
- **THEN** the apply returns `AppError::Mysql { code: Some("23000"), failed_op_index: 1 }`
- **AND** the first insert is rolled back

#### Scenario: Value too long surfaces as 22001

- **WHEN** the user updates a `VARCHAR(10)` column with a 50-character string
- **THEN** the apply returns `AppError::Mysql { code: Some("22001"), failed_op_index: <i> }` after `ROLLBACK`

#### Scenario: Timeout cancellation surfaces as 70100

- **WHEN** the apply exceeds 15 seconds and the cancel token fires
- **THEN** the apply returns `AppError::Mysql { code: Some("70100"), message: <interrupted message> }` after `ROLLBACK`

#### Scenario: Unknown SQLSTATE is forwarded verbatim

- **WHEN** the server returns a SQLSTATE not in the recognized list (e.g. `45000` from a custom `SIGNAL`)
- **THEN** the apply returns `AppError::Mysql { code: Some("45000"), message: <server message>, failed_op_index: <i> }`

### Requirement: Editable mode in the data viewer

The viewer tab `mysql-table-data` SHALL render in editable mode when the active connection's `params.read_only` is `false` AND the relation has a PK (or is being inserted into). The editable mode MUST satisfy the same UX rules as the Postgres equivalent:

- Double-clicking a non-PK cell enters inline edit mode for that cell. PK cells of existing rows MUST remain read-only (changing a PK requires DELETE + INSERT).
- The inline editor's input type adapts to the column's MySQL `DATA_TYPE` (text input, monospaced textarea for long text/JSON/BLOB, number input, boolean select, enum select for `ENUM` types, ISO-string input for `DATE`/`DATETIME`/`TIMESTAMP`/`TIME`). `BLOB`/`VARBINARY` and `GEOMETRY` family columns MUST display a "binary, not editable inline" indicator and reject the double-click.
- Pressing `Tab` or `Enter` inside an inline editor commits the edit to the local buffer (NOT the database) and exits edit mode. Pressing `Escape` cancels the edit. Clicking outside the cell commits the edit to the buffer.
- An edited cell renders with a dirty highlight; a row marked for delete renders with strike-through and faded foreground; inserted rows appear at the top of the visible buffer and persist until commit.

#### Scenario: Double-click on non-PK cell enters edit mode

- **WHEN** the user double-clicks the `email` cell on a row whose PK is `id`
- **THEN** the cell renders an `<input>` with the current value selected
- **AND** the PK column does not become editable

#### Scenario: PK cell of existing row is not editable

- **WHEN** the user double-clicks the `id` cell of an existing row
- **THEN** no inline editor is rendered

#### Scenario: BLOB is not editable inline

- **WHEN** the user double-clicks a `BLOB` cell
- **THEN** no inline editor opens
- **AND** the cell shows a `binary, not editable inline` tooltip

#### Scenario: GEOMETRY is not editable inline

- **WHEN** the user double-clicks a `POINT` cell
- **THEN** no inline editor opens
- **AND** the cell shows a `not editable in v1` tooltip

### Requirement: Edit buffer and undo

The viewer SHALL maintain a per-tab in-memory edit buffer with the same operations and semantics as the Postgres equivalent: `setCellEdit(rowKey, column, newValue)`, `markRowDelete(rowKey)`, `markRowUndelete(rowKey)`, `addInsertRow(values?)`, `undo()`, `clear()`, `commitSuccess(refreshedRows)`. The buffer MUST track every action in a stack so `undo()` removes exactly the most recent action. The buffer MUST NOT persist across app launches. The buffer MUST survive tab switches inside the same session.

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

Editing a column inside the inspector pane SHALL mutate the same edit buffer as the grid cell editor. A change committed in the inspector MUST immediately re-render the corresponding grid cell with the dirty highlight, and a `⌘Z` undo MUST revert both the grid cell and the inspector field together. The inspector MUST disable editing on PK columns of existing rows, BLOB/VARBINARY/GEOMETRY columns, and any column on a read-only connection.

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

### Requirement: Direct save flow

The viewer SHALL apply edits directly when the user presses `⌘S` (or activates the Save button) AND the buffer has at least one dirty entry. The viewer MUST:

- Invoke `mysql_apply_table_edits` with the buffer's serialized `EditOp[]` and `origin: "user"`.
- While the apply is in flight, disable the Save button and show a progress indicator.
- On success, clear the buffer and refresh the viewer (the simplest correct behavior is to re-fetch the first page).
- On `AppError::Mysql`, surface a non-blocking error banner above the grid containing the SQLSTATE (when present), the message, and the `failed_op_index` (e.g. `Op #2 failed: [23000] Duplicate entry '5' for key 'PRIMARY'`). The buffer MUST stay intact.
- On `AppError::Validation` (read-only / payload), surface the same banner with the validation message. The buffer MUST stay intact.

The viewer MUST NOT open a diff preview modal in v1.

`⌘S` detection MUST use a `window`-level `keydown` listener that is active only while the table tab is the active tab — NOT the root `div`'s `onKeyDown` handler. The listener MUST trigger the save whenever the table tab is active AND the currently focused element is `null`/`document.body` OR is contained within the table tab's root element, EXCEPT when the focused element is inside a CodeMirror editor (`.cm-editor`), in which case `⌘S` MUST be left to that editor. Focus being outside the data grid (including no element focused) MUST NOT prevent the save. The non-save key handling (`⌫` delete, `⌘Z` undo, `⌘R` reload) MAY remain on the root `div`'s `onKeyDown`.

#### Scenario: Cmd-S applies the buffer directly

- **WHEN** the user has any dirty entries and presses `⌘S` while the table tab is active
- **THEN** `mysql_apply_table_edits` is invoked with the current `EditOp[]` and `origin: "user"`

#### Scenario: Cmd-S saves when focus is outside the grid

- **WHEN** the user has dirty entries, clicks an empty area so no grid cell is focused (or focuses a toolbar control), and presses `⌘S` while the table tab is active
- **THEN** `mysql_apply_table_edits` is invoked with the current `EditOp[]` and `origin: "user"`

#### Scenario: Cmd-S is left to a focused CodeMirror editor

- **WHEN** focus is inside a `.cm-editor` surface within the tab and the user presses `⌘S`
- **THEN** the viewer does NOT dispatch `mysql_apply_table_edits` from the global listener

#### Scenario: Cmd-S is no-op when buffer is clean

- **WHEN** the user presses `⌘S` with no dirty entries
- **THEN** no command is dispatched

#### Scenario: Apply success refreshes the viewer

- **WHEN** the apply succeeds with 1 update + 1 insert + 1 delete
- **THEN** the buffer is cleared and the viewer re-fetches its first page

#### Scenario: Op-failure banner shows SQLSTATE and 1-based op index

- **WHEN** the apply returns `AppError::Mysql { code: Some("23000"), failed_op_index: 2, message: "Duplicate entry '5' for key 'PRIMARY'" }`
- **THEN** a banner appears above the grid reading `Op #3 failed: [23000] Duplicate entry '5' for key 'PRIMARY'`
- **AND** the buffer is unchanged

### Requirement: Insert and delete affordances

The viewer SHALL render an `Add row` button in the bottom bar that, when activated, appends a new empty row to the buffer with kind `insert` and immediately enters inline edit mode on its first non-auto-increment column. The button MUST be hidden on read-only connections AND on relations whose `TABLE_TYPE` is `VIEW`. Tables with no explicit PK MAY still receive inserts; for those, the `Add row` button stays visible.

The viewer SHALL accept the `Backspace` (`⌫`) key when one or more rows are selected AND no inline editor is active. Pressing `⌫` MUST toggle the delete mark on every row currently in the selection range, following the same mixed-selection rules as the Postgres equivalent (insert rows are removed; clean server rows are marked for delete; already-marked rows are undeleted). All toggles from a single `⌫` press MUST be applied as a single batched buffer action (one undo entry).

For relations with no PK, `⌫` MUST be no-op on server rows in the selection; `insert` rows in the selection MUST still be removable.

#### Scenario: Add row inserts an editable empty row

- **WHEN** the user clicks `Add row`
- **THEN** a new row appears at the top of the buffer with kind `insert`
- **AND** an inline editor opens on the first non-auto-increment editable column

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

When the loaded relation's `columns` (from `mysql_table_primary_key`) is `null`, the viewer SHALL keep `INSERT` enabled but SHALL disable `UPDATE` and `DELETE` affordances. The viewer MUST display a banner in the bottom bar stating that the relation has no primary key and that existing rows cannot be edited or deleted via Argus. Double-clicking an existing-row cell on such a relation MUST be a no-op.

#### Scenario: View has no PK so update/delete are off

- **WHEN** the user opens a view (`columns: null`)
- **THEN** the bottom bar shows a `no primary key` banner
- **AND** double-clicking a cell is a no-op
- **AND** the `Add row` button is hidden (because the relation is a view)

#### Scenario: Table without explicit PK still allows insert

- **WHEN** the user opens a table that has columns but no `PRIMARY KEY` constraint, on a writable connection
- **THEN** the `Add row` button is rendered (insert is allowed)
- **AND** existing rows are read-only with the `no PK` banner visible

### Requirement: Refresh confirmation when the edit buffer is dirty

When the user triggers a table refresh/reload — via the `⌘R` keyboard shortcut, a hard-refresh shortcut, or the reload button in the data-grid toolbar — AND the edit buffer `hasDirty` is `true`, the viewer MUST surface a confirmation dialog reading "Discard N changes and refresh?" (where N is the total of `dirtyCounts.updates + inserts + deletes`) with Confirm and Cancel actions, instead of refreshing immediately. Cancel MUST leave the buffer intact and abort the refresh. Confirm MUST call `buffer.clear()` and then perform the refresh. When `hasDirty` is `false`, the refresh MUST proceed immediately with no dialog.

#### Scenario: Refresh with pending edits prompts confirmation

- **WHEN** the buffer has 2 pending updates and the user presses `⌘R`
- **THEN** a "Discard 2 changes and refresh?" confirmation dialog appears
- **AND** the table is NOT refreshed yet

#### Scenario: Cancel keeps the pending edits

- **WHEN** the refresh-confirmation dialog is open and the user clicks Cancel
- **THEN** the dialog closes, the buffer is unchanged, and the table is not refreshed

#### Scenario: Confirm discards then refreshes

- **WHEN** the refresh-confirmation dialog is open and the user clicks Confirm
- **THEN** the buffer is cleared and the viewer re-fetches the first page

#### Scenario: Clean buffer refreshes without a dialog

- **WHEN** the buffer has no pending edits and the user presses `⌘R`
- **THEN** the table refreshes immediately with no confirmation dialog

### Requirement: Visible pending-edit count and Discard affordance

The data-grid toolbar MUST display a pending-edit count and an explicit **Discard** control whenever the edit buffer `hasDirty` is `true`, and MUST hide both when the buffer is clean. Activating Discard MUST open the same confirmation dialog; on Confirm it MUST call `buffer.clear()` (returning the grid to server values), and on Cancel it MUST leave the buffer intact. The Discard control MUST NOT require closing the tab.

#### Scenario: Pending count appears when buffer is dirty

- **WHEN** the user edits a cell so the buffer has 1 pending change
- **THEN** the toolbar shows a pending-edit count reflecting 1 change and a Discard control

#### Scenario: Discard control clears the buffer after confirmation

- **WHEN** the buffer is dirty and the user activates Discard and confirms
- **THEN** the buffer is cleared and the grid shows the server values again

#### Scenario: Affordance hidden when clean

- **WHEN** the buffer has no pending edits
- **THEN** the toolbar shows neither a pending-edit count nor a Discard control

