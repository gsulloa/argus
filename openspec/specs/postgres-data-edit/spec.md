# postgres-data-edit Specification

## Purpose
Editable-table support for the Postgres data viewer: PK + enum metadata lookup, edit-SQL builder with per-placeholder type casts, transactional apply command. Owned by the Postgres module; consumed by the data-grid editable mode.
## Requirements

### Requirement: Edit operation payload shape

The Postgres module SHALL define a typed `EditOp` payload accepted by the edit commands. `EditOp` MUST be a discriminated union with three variants:

- `{ kind: "update", pk: { [column: string]: JsonValue }, changes: { [column: string]: JsonValue } }` — `pk` carries the row's primary-key columns and their values; `changes` lists the columns being updated and the new values. `changes` MUST be non-empty. `pk` MUST be non-empty and MUST contain every column of the table's PK.
- `{ kind: "insert", values: { [column: string]: JsonValue } }` — `values` lists every non-default column the user supplied. Columns omitted from `values` MUST NOT appear in the resulting `INSERT` (so the database default fires).
- `{ kind: "delete", pk: { [column: string]: JsonValue } }` — `pk` MUST be non-empty and MUST contain every column of the table's PK.

JSON values MUST be carried verbatim and bound as Postgres parameters (never interpolated into SQL). The backend MUST validate the shape and reject malformed payloads with `AppError::Validation` before opening any transaction.

#### Scenario: Update without changes is rejected

- **WHEN** the frontend sends `{ kind: "update", pk: { id: 1 }, changes: {} }`
- **THEN** the command returns `AppError::Validation` with a message naming the offending op
- **AND** no SQL is dispatched

#### Scenario: Update missing a PK column is rejected

- **WHEN** the table's PK is `(tenant_id, user_id)` and the frontend sends `{ kind: "update", pk: { user_id: 7 }, changes: { name: "x" } }`
- **THEN** the command returns `AppError::Validation` with a message naming the missing PK columns

#### Scenario: Insert with omitted columns relies on database defaults

- **WHEN** the frontend sends `{ kind: "insert", values: { name: "ana" } }` against a table where `id` has a `SERIAL` default
- **THEN** the issued SQL is `INSERT INTO "schema"."rel" ("name") VALUES ($1) RETURNING *` with `$1 = "ana"`
- **AND** the response contains the inserted row including the server-assigned `id`

#### Scenario: Delete missing PK column is rejected

- **WHEN** the table's PK is `(tenant_id, user_id)` and the frontend sends `{ kind: "delete", pk: { user_id: 7 } }`
- **THEN** the command returns `AppError::Validation`

### Requirement: Primary key lookup command

The Postgres module SHALL expose a Tauri command `postgres_table_primary_key(connection_id, schema, relation, origin?)` that returns `{ pk_columns: string[] | null, enums: { [column: string]: string[] } }`. `pk_columns` MUST list the PK columns in their declared order, or be `null` when the relation has no primary key. `enums` MUST map each column whose `pg_type.typcategory = 'E'` to the array of allowed enum labels in declared order. The command SHALL acquire a connection from the pool registry, MUST honor the same read-only-aware `executeQuery` path used by `postgres_query_table`, and MUST emit one `argus:activity-log` event before returning with `kind: "list_table_extras"` (reusing the existing kind for catalog metadata) and `metric: { kind: "items", value: <pk_columns_count + enum_columns_count, treating null as 0> }`.

#### Scenario: Table with simple PK

- **WHEN** the frontend invokes `postgres_table_primary_key(id, "public", "users")`
- **THEN** the response contains `{ pk_columns: ["id"], enums: {} }`

#### Scenario: Table with composite PK

- **WHEN** the frontend invokes the command for a table with PK `(tenant_id, user_id)` declared in that order
- **THEN** the response is `{ pk_columns: ["tenant_id", "user_id"], enums: {} }`

#### Scenario: View has no PK

- **WHEN** the frontend invokes the command against a view (`pg_class.relkind = 'v'`)
- **THEN** the response is `{ pk_columns: null, enums: {} }`

#### Scenario: Enum columns are surfaced

- **WHEN** the table has a column `status` of enum type with values `("active", "archived", "deleted")`
- **THEN** the response includes `enums: { status: ["active", "archived", "deleted"] }`

### Requirement: Edit-SQL builder

The Postgres module SHALL implement a pure builder `build_edit_sql(schema, relation, op, columns)` that returns `{ sql: string, params: Vec<Param> }`. The builder MUST:

- Quote `schema` and `relation` via the existing `quote_ident` helper.
- Quote every column name via `quote_ident`.
- Bind every value as a parameter (`$1`, `$2`, …) — never interpolate values into SQL.
- Emit each placeholder with an explicit Postgres cast `::<data_type>` derived from the column's declared `data_type` (as returned by `pg_catalog.format_type`). This works around `tokio-postgres`' default bind-type inference, which only matches `String` to text-family columns; the cast lets Postgres convert the bound text to any cast-from-text type (numeric, uuid, jsonb, timestamp, inet, etc.). All edit values therefore travel as `Option<String>` over the wire.
- For `update`: emit `UPDATE <qualified> SET "c1" = $1::<type1>, "c2" = $2::<type2>, ... WHERE "pk1" = $N::<pk_type1> AND "pk2" = $N+1::<pk_type2>, ... RETURNING *`. The order of `SET` columns MUST match the iteration order of `changes` and MUST be deterministic (sorted by column name).
- For `insert`: emit `INSERT INTO <qualified> ("c1", "c2", ...) VALUES ($1::<type1>, $2::<type2>, ...) RETURNING *`. Columns omitted from `values` MUST NOT appear.
- For `delete`: emit `DELETE FROM <qualified> WHERE "pk1" = $1::<pk_type1> AND "pk2" = $2::<pk_type2> ...`.

The builder MUST be reused by `postgres_apply_table_edits`.

#### Scenario: Update produces parameterized SQL with type casts

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { name: "ana", email: "a@b.com" } }` against `"public"."users"` (id is `bigint`, name is `text`, email is `text`)
- **THEN** the returned `sql` is `UPDATE "public"."users" SET "email" = $1::text, "name" = $2::text WHERE "id" = $3::bigint RETURNING *` (columns alphabetized) and `params` is `["a@b.com", "ana", "1"]`

#### Scenario: Insert respects supplied columns only and casts each placeholder

- **WHEN** the builder is called with `insert { values: { name: "ana" } }` against `"public"."users"` (name is `text`)
- **THEN** the returned `sql` is `INSERT INTO "public"."users" ("name") VALUES ($1::text) RETURNING *` with `params: ["ana"]`

#### Scenario: Delete with composite PK casts each PK placeholder

- **WHEN** the builder is called with `delete { pk: { tenant_id: 5, user_id: 7 } }` (both `integer`)
- **THEN** the returned `sql` is `DELETE FROM "public"."t" WHERE "tenant_id" = $1::integer AND "user_id" = $2::integer` with `params: ["5", "7"]`

#### Scenario: Pathological identifier is escaped

- **WHEN** the builder is called against a relation named `we"ird`
- **THEN** the returned `sql` quotes it as `"we""ird"` (standard double-quote-doubling)

#### Scenario: NULL value with a non-text column casts correctly

- **WHEN** the builder is called with `update { pk: { id: 1 }, changes: { age: null } }` (age is `integer`)
- **THEN** the returned `sql` contains `SET "age" = $1::integer` and the bound parameter is `Option::<String>::None`
- **AND** the resulting Postgres expression `null::integer` is a properly-typed NULL in the column

### Requirement: Apply command and transactional commit

The Postgres module SHALL expose a Tauri command `postgres_apply_table_edits(connection_id, schema, relation, edits, origin?)` that executes all `edits` in a single Postgres transaction. The command MUST:

1. Reject upfront with `AppError::Validation { message: "connection is read-only" }` if the pool's `read_only` flag is set.
2. Acquire a single client from the pool and execute `BEGIN`.
3. For each `EditOp` in order, build the SQL via the shared builder and `client.query(sql, params)`. For `update` and `insert`, capture the row returned by `RETURNING *`.
4. On any error, execute `ROLLBACK` and return `AppError::Postgres { code, message, failed_op_index }` where `failed_op_index` is the 0-based index of the failing op. The buffer-level intent (the original `edits`) is NOT modified by the backend.
5. On success, execute `COMMIT` and return `{ committed: number, refreshed_rows: Array<{ pk: { [col: string]: JsonValue }, row: Array<CellValue> | null }>, query_ms: number }`. `refreshed_rows` MUST contain one entry per `update` (the post-update row from `RETURNING *`) and one entry per `insert` (the post-insert row including server-assigned PK from `RETURNING *`); `delete` ops produce no entry.

The command MUST reuse the same 15s timeout + cancel-token pattern as `postgres_query_table`. The command MUST emit exactly one `argus:activity-log` event before returning, with `kind: "apply_edits"`, `connection_id: <id>`, `origin: <argument or "user">`, `sql: <concatenated SQL of all ops separated by "; ", truncated to 4000 chars>`, `params: null` (per-op params would balloon; `params` is `null` for this kind), `metric: { kind: "rows", value: <total rows affected> }` on success (`null` on failure), and `status` matching the result. Frontend call sites that initiate the command in response to `⌘S` or the diff-preview confirm button MUST pass `origin: "user"`.

#### Scenario: All edits succeed in one transaction

- **WHEN** the frontend invokes the command with three edits and they all succeed
- **THEN** the database state reflects all three changes
- **AND** the response has `committed: 3` and `refreshed_rows.length` equal to the count of update + insert ops (delete contributes 0)

#### Scenario: Mid-transaction failure rolls back everything

- **WHEN** the frontend invokes the command with five edits and the third fails (e.g. `23505 unique_violation`)
- **THEN** the database state shows none of the five changes applied
- **AND** the command returns `AppError::Postgres { code: Some("23505"), failed_op_index: 2 }`

#### Scenario: Rejection on read-only connection

- **WHEN** the frontend invokes the command against a connection whose pool is `read_only: true`
- **THEN** the command returns `AppError::Validation` with message containing `"read-only"`
- **AND** no `BEGIN` statement is dispatched

#### Scenario: RETURNING populates refreshed_rows for update

- **WHEN** the frontend updates a row whose PK is `id = 1` to `name = "ana"`
- **THEN** the `refreshed_rows` entry has `pk: { id: 1 }` and `row` matching the column-positional shape returned by `postgres_query_table`

#### Scenario: RETURNING populates refreshed_rows for insert with server-assigned PK

- **WHEN** the frontend inserts `{ name: "ana" }` against a table with `id SERIAL`
- **THEN** the `refreshed_rows` entry has `pk: { id: <new server-assigned id> }`

#### Scenario: Activity-log event reflects the commit

- **WHEN** `postgres_apply_table_edits` succeeds with 5 ops affecting 5 rows
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "apply_edits"`, `status: "ok"`, `metric: { kind: "rows", value: 5 }`, `origin: "user"`, `sql` containing the concatenated statements

### Requirement: Editable mode in the data viewer

The viewer tab `postgres-table-data` SHALL render in editable mode when the active connection's `params.read_only` is `false` AND the relation has a PK (or is being inserted into). The editable mode MUST satisfy:

- Double-clicking a non-PK cell enters inline edit mode for that cell. PK cells of existing rows MUST remain read-only (changing a PK requires DELETE + INSERT).
- The inline editor's input type adapts to the column's `data_type` (text input, monospaced textarea for long text/jsonb/array, number input, boolean select, enum select for enum types, ISO-string input for date/timestamp). `bytea` and other non-trivial binary types MUST display a "binary, not editable inline" indicator and reject the double-click.
- Pressing `Tab` or `Enter` inside an inline editor commits the edit to the local buffer (NOT the database) and exits edit mode. Pressing `Escape` cancels the edit and reverts that cell. Clicking outside the cell commits the edit to the buffer.
- A cell that has been edited (in the local buffer) is rendered with a dirty highlight (background distinct from the standard hover/active row colors).
- A row marked for delete is rendered with strike-through text and a faded foreground color.
- Inserted rows (kind `insert` in the buffer) MUST appear at the top of the visible buffer and persist there until commit; they MUST NOT be reordered by the active sort.

#### Scenario: Double-click on non-PK cell enters edit mode

- **WHEN** the user double-clicks the `email` cell on a row whose PK is `id`
- **THEN** the cell renders an `<input>` with the current value selected
- **AND** the cell's PK column does not become editable

#### Scenario: PK cell of existing row is not editable

- **WHEN** the user double-clicks a `id` cell of an existing row
- **THEN** no inline editor is rendered

#### Scenario: Edit reflects in dirty state

- **WHEN** the user edits a cell from `"old"` to `"new"` and tabs out
- **THEN** the cell renders with the dirty highlight
- **AND** the cell's displayed value is `"new"`
- **AND** the database state still shows `"old"` (no commit yet)

#### Scenario: Escape reverts the cell

- **WHEN** the user types into a cell and presses `Escape`
- **THEN** the cell exits edit mode
- **AND** the cell is NOT marked dirty (the edit was discarded)

#### Scenario: bytea is not editable inline

- **WHEN** the user double-clicks a `bytea` cell
- **THEN** no inline editor opens
- **AND** the cell shows a "binary, not editable inline" tooltip

### Requirement: Buffer model and undo

The viewer SHALL maintain a per-tab in-memory edit buffer with the following operations: `setCellEdit(rowKey, column, newValue)`, `markRowDelete(rowKey)`, `markRowUndelete(rowKey)`, `addInsertRow(values?)`, `undo()`, `clear()`, `commitSuccess(refreshedRows)`. The buffer MUST track every action in a stack so that `undo()` removes exactly the most recent action. The buffer MUST NOT persist to disk across app launches. The buffer MUST survive tab switches inside the same session (switching to another tab and back leaves the buffer intact).

#### Scenario: Undo reverts the last cell edit

- **WHEN** the user edits cell A then cell B, then presses `⌘Z`
- **THEN** cell B reverts to its server value (no longer dirty)
- **AND** cell A remains dirty with its edited value

#### Scenario: Undo can revert a delete mark

- **WHEN** the user marks row R for delete, then presses `⌘Z`
- **THEN** row R is no longer marked for delete

#### Scenario: Buffer survives tab switch

- **WHEN** the user has 3 dirty cells, switches to another tab, and returns
- **THEN** the 3 cells are still dirty and the buffer is intact

#### Scenario: Tab close with dirty buffer prompts confirmation

- **WHEN** the user attempts to close the tab while the buffer has any dirty entries
- **THEN** a confirmation dialog appears asking "Discard N changes?"
- **AND** clicking `Cancel` keeps the tab open with the buffer intact

### Requirement: Insert and delete affordances

The viewer SHALL render an "Add row" button in the bottom bar that, when activated, appends a new empty row to the buffer with kind `insert` and immediately enters inline edit mode on its first non-default column. The button MUST be hidden on read-only connections AND on relations with no PK (since INSERT is allowed without a PK, the button stays visible for tables with no PK — only relations that are views/materialized-views hide it).

The viewer SHALL accept the `Backspace` (`⌫`) key when one or more rows are selected AND no inline editor is active. Pressing `⌫` MUST toggle the delete mark on the selected rows. The action MUST be no-op on read-only connections. The action MUST be no-op on rows that are themselves `insert` rows (to delete an insert row, the user undoes via `⌘Z` or removes it via the buffer's discard control).

#### Scenario: Add row inserts an editable empty row

- **WHEN** the user clicks "Add row"
- **THEN** a new row appears at the top of the buffer with kind `insert`
- **AND** an inline editor opens on the first editable column

#### Scenario: Add row hidden on a view

- **WHEN** the relation is a view (`relationKind: "view"`)
- **THEN** the "Add row" button is not rendered

#### Scenario: Backspace marks delete on selected rows

- **WHEN** the user selects 3 rows and presses `⌫`
- **THEN** all 3 rows are marked for delete (rendered with strike-through)

#### Scenario: Backspace is no-op on read-only connection

- **WHEN** the user attempts the same action on a connection where `params.read_only: true`
- **THEN** no rows are marked for delete

### Requirement: Direct save flow

The viewer SHALL apply edits directly when the user presses `⌘S` (or activates the Save button) AND the buffer has at least one dirty entry. The viewer MUST:

- Invoke `postgres_apply_table_edits` with the buffer's serialized `EditOp[]` and `origin: "user"`.
- While the apply is in flight, disable the Save button and show a progress indicator on it.
- On apply success (`outcome: "ok"`), clear the buffer and refresh the viewer's row list (the simplest correct behavior is to re-fetch the first page; surgical row-replace is a follow-up).
- On `outcome: "op_failed"`, surface a non-blocking error banner above the grid containing the SQLSTATE code (when present), the error message, and the `failed_op_index` (e.g. `Op #2 failed: 23505 unique_violation`). The buffer MUST stay intact.
- On thrown `AppError` (validation / read-only), surface the same banner with the error message. The buffer MUST stay intact.

The viewer MUST NOT open a diff preview modal. The diff preview command (`postgres_preview_table_edits`) does not exist in this capability.

#### Scenario: Cmd-S applies the buffer directly

- **WHEN** the user has any dirty entries and presses `⌘S` while the table tab is focused
- **THEN** `postgres_apply_table_edits` is invoked with the current `EditOp[]` and `origin: "user"`
- **AND** no preview modal is rendered

#### Scenario: Cmd-S is no-op when buffer is clean

- **WHEN** the user presses `⌘S` with no dirty entries
- **THEN** no command is dispatched

#### Scenario: Apply success refreshes the viewer

- **WHEN** the apply succeeds with 1 update + 1 insert + 1 delete
- **THEN** the buffer is cleared
- **AND** the viewer re-fetches its first page so the user sees the committed state

#### Scenario: Op-failure banner stays until dismissed or next save

- **WHEN** the apply returns `outcome: "op_failed"` with `failed_op_index: 2`, code `"23505"`, message `"unique_violation"`
- **THEN** an error banner appears above the grid showing `Op #3 failed: [23505] unique_violation` (1-based index for users)
- **AND** the buffer is unchanged
- **AND** the banner is dismissable; the next ⌘S also clears it

### Requirement: Read-only enforcement

`postgres_apply_table_edits` MUST reject any invocation against a connection whose pool's `read_only` flag is `true`, with `AppError::Validation { message: "connection is read-only" }`, BEFORE any SQL is dispatched. The frontend MUST hide every edit affordance (edit-on-double-click, "Add row", `⌫`, `⌘S`) on read-only connections AND display a persistent banner in the bottom bar reading "Read-only connection — edits disabled".

#### Scenario: Backend rejects edit attempt on read-only connection

- **WHEN** any caller invokes `postgres_apply_table_edits` for a read-only connection
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }`
- **AND** no `BEGIN`, `UPDATE`, `INSERT`, `DELETE` statement is dispatched to the server

#### Scenario: UI hides edit affordances on read-only connection

- **WHEN** the user opens a table tab against a connection with `params.read_only: true`
- **THEN** double-clicking a cell does not enter edit mode
- **AND** the "Add row" button is not rendered
- **AND** the bottom bar displays a "Read-only connection — edits disabled" banner

### Requirement: Tables without a PK

When the loaded relation's `pk_columns` is `null`, the viewer SHALL keep `INSERT` enabled but SHALL disable `UPDATE` and `DELETE` affordances. The viewer MUST display a banner in the bottom bar stating that the relation has no primary key and that existing rows cannot be edited or deleted via Argus. Double-clicking an existing-row cell on such a relation MUST be a no-op.

#### Scenario: View has no PK so insert/update/delete are off

- **WHEN** the user opens a view (`pk_columns: null`)
- **THEN** the bottom bar shows a banner explaining the relation has no PK
- **AND** double-clicking a cell is a no-op (no inline editor)
- **AND** the "Add row" button is hidden

#### Scenario: Table without explicit PK still allows insert

- **WHEN** the user opens a table that has columns but no `PRIMARY KEY` constraint, on a writable connection
- **THEN** the "Add row" button is rendered (insert is allowed)
- **AND** existing rows are read-only with the "no PK" banner visible
