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

The Postgres module SHALL implement a pure builder `build_edit_sql(schema, relation, op, columns, pk_columns)` that returns `{ sql: string, params: Vec<BoundParam> }`. The builder MUST:

- Quote `schema` and `relation` via the existing `quote_ident` helper.
- Quote every column name via `quote_ident`.
- Bind every value as a parameter (`$1`, `$2`, …) — never interpolate values into SQL.
- Use a type-aware binding strategy keyed off each column's declared `data_type` (as returned by `pg_catalog.format_type`). Three binding modes:
  - **Native-bind primitives** (`smallint`/`int2`, `integer`/`int4`, `bigint`/`int8`, `real`/`float4`, `double precision`/`float8`, `boolean`, `text`/`character varying`/`varchar`/`character`/`char`/`bpchar`/`name`/`citext`): the JSON value is parsed into the matching Rust primitive (`i16`/`i32`/`i64`/`f32`/`f64`/`bool`) or owned `String`, and bound directly. Placeholder is rendered as plain `$N` with no cast.
  - **Native-bind JSON** (`json`, `jsonb`): the JSON value is bound directly as `serde_json::Value` via tokio-postgres' `with-serde_json-1` feature. Placeholder is rendered as plain `$N` with no cast. Structured (`array`/`object`), scalar (number/string/bool), and `null` shapes are all accepted.
  - **Cast-from-text types** (`uuid`, `numeric`/`decimal`, `date`, `time`, `time with time zone`/`timetz`, `timestamp`, `timestamp with time zone`/`timestamptz`, `bytea`, plus a fallback for any unrecognized type): the JSON value is coerced to a `String` and bound as text. Placeholder is rendered as `$N::text::<type>`. The inner `::text` cast forces Postgres to infer `$N` as `text` (which is what tokio-postgres binds `String` to); the outer cast does the server-side conversion to the target type. A single-cast `$N::<type>` would make Postgres infer `$N` as the target type directly (since the cast is identity on those types), and tokio-postgres would reject the bind with `error serializing parameter N`.
  - JSON `null` MUST bind as the typed `Option::<T>::None` for the column's bind kind (e.g. `Option::<i32>::None` for `integer`, `Option::<serde_json::Value>::None` for `jsonb`, `Option::<String>::None` for `uuid`). The placeholder shape MUST match the non-null case for the same kind.
  - JSON `array` and `object` values MUST be accepted only when the column's bind kind is `json` or `jsonb` (where they bind natively as `serde_json::Value`). For every other kind, structured JSON values MUST be rejected with `AppError::Validation` naming the column and its data type.
- For `update`: emit `UPDATE <qualified> SET "c1" = <ph1>, "c2" = <ph2>, ... WHERE "pk1" = <ph_n> AND "pk2" = <ph_n+1>, ... RETURNING *`. The order of `SET` columns MUST match the iteration order of `changes` (BTreeMap, so alphabetical) and MUST be deterministic.
- For `insert`: emit `INSERT INTO <qualified> ("c1", "c2", ...) VALUES (<ph1>, <ph2>, ...) RETURNING *`. Columns omitted from `values` MUST NOT appear.
- For `delete`: emit `DELETE FROM <qualified> WHERE "pk1" = <ph1> AND "pk2" = <ph2> ...`.

UPDATE and INSERT statements MUST wrap their inner statement in `WITH _argus_r AS (<inner>) SELECT row_to_json(_argus_r)::text FROM _argus_r` so the apply command can decode the refreshed row through the existing data-module pipeline.

The builder MUST be reused by `postgres_apply_table_edits`. All bind-validation errors (e.g. value out of range, structured JSON for non-json column, malformed integer string) MUST surface as `AppError::Validation` from the builder, which the apply command propagates as a thrown error before opening any transaction.

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

### Requirement: Bulk-edit mode in the inspector when multiple rows are selected

When the data grid has 2 or more rows selected (see `postgres-data-grid`, requirement "Drag-to-select row range") AND the **effective** selection (filtered as defined below) contains 2 or more rows, the inspector panel SHALL render in **bulk-edit mode** instead of its normal single-row view. The grid's inline cell editor MUST be suppressed while bulk-edit mode is active: double-clicking a cell MUST be a no-op.

**Effective selection filtering.** Before deciding which mode to render, the viewer MUST exclude from the selection:

- Rows whose `source` is `"insert"` (no server-assigned PK).
- Rows currently marked for delete in the edit buffer.
- Rows that lack a `rowKey`.

If the resulting effective count is `0` or `1`, the inspector MUST render in its existing single-row mode (and the row shown is the `active` row of the selection range), and the inline cell editor MUST be re-enabled.

If the relation has no primary key (`pkColumns === null`), the inspector MUST render a banner reading `Bulk edit unavailable on relations without a primary key` instead of editable fields. The Apply button MUST NOT be rendered in that case.

**Inspector header in bulk mode.** The inspector header MUST display `Inspector · <N> rows selected` where `<N>` is the effective count.

**Field rendering in bulk mode.** For every column of the relation:

- If the column is the relation's PK, `looksLikeBytea` of its `data_type`, OR at least one row in the effective selection has a cell envelope (`isCellEnvelope`) for that column, the column MUST be rendered read-only with a tooltip explaining why (PK / binary / envelope, respectively).
- If the connection is read-only, the column MUST be rendered read-only (consistent with the existing single-row inspector).
- Otherwise, the column MUST render an editable field using the same input types as the existing `InspectorEditableField` (boolean select, enum select, JSON/long-text textarea, numeric input, text input).

**Initial value of each editable field.**

- If every row in the effective selection has the same value in that column (compared by structural equality for objects/arrays, strict equality for scalars), the field MUST initialize with that common value in `pristine` state.
- If the rows have at least two distinct values in that column, the field MUST initialize empty (internal value `null`) with placeholder text `— multiple values —` styled `color: var(--muted); font-style: italic`.

**Per-field `touched` state.**

- Each editable field MUST track a local boolean `touched`, initially `false`.
- Any user interaction that changes the field's current value (typing into an input/textarea, picking a non-default option in a select, toggling a boolean) MUST set `touched = true`.
- A field with `touched === true` MUST render a distinguishing indicator: an accent-colored left border on the field AND a small filled dot (●) next to its label.
- A field with `touched === true` MUST render an `↺` revert button adjacent to its input. Clicking the revert button MUST set `touched = false` and reset the field's content to its pristine state (the common value, or empty + placeholder, as initialized).

**Apply footer.** When the inspector is in bulk-edit mode AND `pkColumns !== null`, a sticky footer MUST render at the bottom of the inspector body containing:

- A primary button `Apply to <N> rows` where `<N>` is the effective count. The button MUST be disabled when zero fields are touched, and enabled otherwise. Clicking the button MUST:
  1. Validate every touched field: JSON/JSONB columns MUST pass the same `validateJsonInput` strict-parse as the single-cell editor; any other per-type validation (numeric range, etc.) reuses the existing single-cell path. If any touched field fails validation, the apply MUST be aborted, the offending field MUST render its inline error UI (existing pattern: `danger` border + error text), and the buffer MUST NOT be mutated.
  2. Build `entries: Array<{ rowKey, column, value, pk, originalRow, originalColumns }>` of cardinality `M_touched × N_effective` (one entry per touched field, per eligible row), where `value` is the validated value from the field (or `null` for touched+empty), and `pk` is captured from each row's server cells.
  3. Invoke `buffer.bulkSetCellEdit(entries)` in a single dispatch.
  4. After a successful apply, reset every field to `touched = false` AND re-initialize each field's value from the (now updated) buffer-aware view of the same selected rows so that the inspector reflects the just-applied state in pristine.
- A secondary button `Cancel` MUST reset every touched field to pristine (`touched = false`, content reset) without modifying the buffer. The `Cancel` button does NOT clear the row selection.

**Selection-change ephemerality.** If the user changes the selection range while the inspector is in bulk-edit mode with touched fields, the touched state is discarded (the inspector remounts for the new selection). No confirmation dialog is required in this iteration.

**Backend.** The Tauri command `postgres_apply_table_edits` and the payload shape `EditOp` are NOT modified by this requirement. The `M_touched × N_eligible` entries collapse into `N_eligible` `EditOp.update` operations whose `changes` map contains all `M_touched` columns. The existing transactional apply commits atomically.

#### Scenario: 10 rows selected, one common-value column, two distinct-value columns

- **WHEN** the user has 10 server rows selected; column `status` is `"active"` in all 10 rows, column `priority` has 3 distinct values across the 10 rows, column `notes` has 7 distinct values
- **THEN** the inspector renders in bulk mode with `Inspector · 10 rows selected` in the header
- **AND** the `status` field initializes with value `"active"` in pristine state
- **AND** the `priority` field initializes empty with placeholder `— multiple values —`
- **AND** the `notes` field initializes empty with placeholder `— multiple values —`
- **AND** no field shows the touched indicator
- **AND** the Apply footer reads `Apply to 10 rows` and is disabled

#### Scenario: Touching a field enables Apply and shows the indicator

- **WHEN** the user types `archived` in the `status` field
- **THEN** the `status` field's left border becomes accent-colored, a ● dot appears next to its label, and an `↺` button appears next to its input
- **AND** the `Apply to 10 rows` button becomes enabled

#### Scenario: Touching multiple fields then applying writes all columns to all rows

- **WHEN** the user touches `status` (typed `archived`), `priority` (selected `low` in an enum), and clicks `Apply to 10 rows`
- **THEN** the edit buffer gains 10 `update` entries, one per eligible row, each with `changes: { status: "archived", priority: "low" }` and the row's own PK
- **AND** the dirty count in the bottom bar increases by 10
- **AND** `notes` is NOT in any of the `changes` (it was never touched)
- **AND** after apply, all fields are reset to `touched = false` and the inspector re-initializes (now `status` is `"archived"` in pristine, `priority` is `"low"` in pristine)

#### Scenario: Touched + empty applies NULL to all rows

- **WHEN** the user clicks the `notes` field (which shows the `— multiple values —` placeholder), types some text, then deletes everything so the field is empty (but touched remains true)
- **AND** clicks `Apply to 10 rows`
- **THEN** the buffer entry for `notes` writes `null` to all 10 eligible rows

#### Scenario: Revert button restores pristine state

- **WHEN** the user types `archived` in `status`, then clicks the `↺` button next to `status`
- **THEN** `status` re-shows its pristine common value `"active"`, the touched indicator disappears, and the `↺` button disappears
- **AND** if `status` was the only touched field, `Apply to 10 rows` becomes disabled again

#### Scenario: Cancel resets all touched fields without touching the buffer or the selection

- **WHEN** the user has touched `status` and `priority`, has 3 dirty cells from previous unrelated edits in the buffer, and clicks `Cancel`
- **THEN** the `status` and `priority` fields reset to pristine; the touched indicators disappear
- **AND** the 3 unrelated dirty cells remain in the buffer
- **AND** the row selection remains intact (rows 5..14 still highlighted)

#### Scenario: Invalid JSON in a touched field aborts the apply

- **WHEN** the user has touched `metadata` (jsonb) with text `{ "flag": ` (missing closing brace) and another field with valid content, and clicks `Apply to 10 rows`
- **THEN** the `metadata` field renders the danger-border + inline-error UI defined in requirement "JSON/JSONB edits validate as strict JSON on commit"
- **AND** the buffer is NOT mutated for any row or any column
- **AND** the touched state of all fields is preserved (no reset) so the user can fix and retry

#### Scenario: Selection drops to 1 effective row → inspector falls back to single-row mode

- **WHEN** the user has 10 rows selected, then drags to narrow the selection to a single row (or 8 of 10 are marked for delete and 1 is an insert, leaving 1 eligible)
- **THEN** the inspector remounts in single-row mode showing the active row
- **AND** the bulk Apply footer disappears
- **AND** the inline cell editor is re-enabled (double-click works again)

#### Scenario: No-PK relation hides the bulk editor

- **WHEN** the user selects 5 rows on a view (relation with `pkColumns === null`)
- **THEN** the inspector header still shows `Inspector · 5 rows selected`
- **AND** the body renders the banner `Bulk edit unavailable on relations without a primary key`
- **AND** no editable fields are rendered
- **AND** no Apply footer is rendered

#### Scenario: Read-only connection in bulk selection shows read-only fields

- **WHEN** the user is on a read-only connection and selects 5 rows
- **THEN** the inspector shows the 5-row bulk view but every field is read-only (consistent with the existing single-row read-only behavior)
- **AND** no Apply footer is rendered

#### Scenario: A bulk apply collapses into one EditOp.update per row with multiple columns in changes

- **WHEN** the user applies a bulk edit touching `status` and `priority` over 10 eligible rows, then presses `⌘S`
- **THEN** `postgres_apply_table_edits` is invoked with `edits: EditOp[]` of length 10, each entry being `{ kind: "update", pk: {...}, changes: { status: <v1>, priority: <v2> } }`
- **AND** all 10 ops commit in a single transaction

#### Scenario: Inline cell editor is suppressed while bulk-edit mode is active

- **WHEN** the user has 5 eligible rows selected (effective count ≥ 2) and double-clicks any non-PK cell in the grid
- **THEN** no inline editor opens
- **AND** the grid cells render with `cursor: default` (not `text`)

#### Scenario: Single `⌘Z` reverts the entire bulk apply

- **WHEN** the user has applied a bulk edit of `status = "archived"` + `priority = "low"` over 10 rows (10 buffer entries), then presses `⌘Z` once
- **THEN** all 10 entries are removed from the buffer in a single undo step
- **AND** none of the 50 affected cells render with the dirty-state background

### Requirement: Insert and delete affordances

The viewer SHALL render an "Add row" button in the bottom bar that, when activated, appends a new empty row to the buffer with kind `insert` and immediately enters inline edit mode on its first non-default column. The button MUST be hidden on read-only connections AND on relations with no PK (since INSERT is allowed without a PK, the button stays visible for tables with no PK — only relations that are views/materialized-views hide it).

The viewer SHALL accept the `Backspace` (`⌫`) key when one or more rows are selected AND no inline editor is active. Pressing `⌫` MUST toggle the delete mark on every row currently in the selection range. The action MUST be no-op on read-only connections. For each row in the selection range:

- If the row is an `insert` row (kind `insert` in the buffer), the row MUST be removed from the buffer entirely (consistent with the single-row behavior).
- Else if the row is a server row with a PK and is NOT already marked for delete, the row MUST be marked for delete using its PK.
- Else if the row is already marked for delete, the row's delete mark MUST be cleared (undelete).

All toggles produced by a single `⌫` press MUST be applied as a single batched action in the buffer (one undo entry, one React render), regardless of how many rows the selection contains. For relations with no PK, `⌫` MUST be no-op on server rows in the selection (delete of existing rows requires a PK); `insert` rows in the selection MUST still be removable.

#### Scenario: Add row inserts an editable empty row

- **WHEN** the user clicks "Add row"
- **THEN** a new row appears at the top of the buffer with kind `insert`
- **AND** an inline editor opens on the first editable column

#### Scenario: Add row hidden on a view

- **WHEN** the relation is a view (`relationKind: "view"`)
- **THEN** the "Add row" button is not rendered

#### Scenario: Backspace marks delete on the selection range

- **WHEN** the user selects rows 5..14 (10 server rows, none deleted) and presses `⌫`
- **THEN** all 10 rows are marked for delete (rendered with strike-through)
- **AND** the buffer records a single undo entry for the bulk toggle
- **AND** pressing `⌘Z` once reverts all 10 delete marks

#### Scenario: Backspace toggles mixed selection in one action

- **WHEN** the user selects rows 5..14 where row 7 is already marked for delete, row 5 is an `insert` row, and the others are clean server rows
- **AND** presses `⌫`
- **THEN** row 5 is removed from the buffer (insert removal)
- **AND** row 7's delete mark is cleared (undelete)
- **AND** rows 6, 8, 9, 10, 11, 12, 13, 14 are newly marked for delete
- **AND** the action is recorded as a single undo entry

#### Scenario: Backspace is no-op on read-only connection

- **WHEN** the user attempts the same action on a connection where `params.read_only: true`
- **THEN** no rows are marked for delete

#### Scenario: Backspace is no-op on server rows of a no-PK relation

- **WHEN** the user has selected rows 5..14 on a view (no PK) and presses `⌫`
- **THEN** no server rows are marked for delete
- **AND** any `insert` rows in the selection are still removed

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

### Requirement: JSON/JSONB cell editor disables native autocorrect

When the inline cell editor (in the data grid OR in the row inspector) is mounted for a column whose `data_type` matches `looksLikeJson(t)` — currently `json`, `jsonb`, anything ending in `[]`, or anything starting with `_` — the underlying `<textarea>` MUST render with the following attributes:

- `autoCorrect="off"`
- `autoCapitalize="off"`
- `spellCheck={false}`
- `autoComplete="off"`

The purpose is to prevent the host OS (notably macOS) from rewriting typed characters (smart quotes, em-dashes, capitalization) before React receives them. These attributes are NOT required for non-JSON column types (text columns may legitimately want autocorrect for prose).

#### Scenario: Typing a straight quote in a jsonb cell produces a straight quote

- **WHEN** the user double-clicks a `jsonb` cell on macOS with the system "Smart Quotes" preference enabled
- **AND** types the character `"`
- **THEN** the textarea's value contains the ASCII character `"` (U+0022), NOT a curly quote (`"` U+201C or `"` U+201D)

#### Scenario: Pasting smart-quoted JSON into a jsonb cell is preserved as-typed

- **WHEN** the user pastes the literal string `{"foo":"bar"}` (with U+201C / U+201D as the outer quotes) into a `jsonb` cell editor
- **THEN** the textarea displays the pasted string with the smart quotes intact (the OS does not auto-rewrite them but it also does not strip them — that's the next requirement's job)

#### Scenario: Text columns are unaffected

- **WHEN** the user opens an inline editor for a `text` or `varchar` column
- **THEN** the textarea does NOT have `autoCorrect="off"` (autocorrect remains enabled per the OS default)

### Requirement: JSON/JSONB edits validate as strict JSON on commit

When the user commits a json/jsonb cell edit (Tab / Enter / clicking outside the cell / `<textarea>` blur in the row inspector), the frontend MUST validate the textarea contents by:

1. Trimming leading and trailing whitespace.
2. If the trimmed value is empty (`""`), treat the commit as a NULL write (existing behavior) — no parse is attempted.
3. Otherwise, attempt `JSON.parse(trimmed)`:
   - If parsing succeeds, the value sent to the edit buffer (and ultimately to the backend as `EditOp.update.changes[col]`) MUST be `JSON.stringify(parsed)` — the canonical re-serialization. The user-visible cell value MUST be the canonical form (so the displayed cell after commit reflects exactly what was sent).
   - If parsing fails, the commit MUST be rejected: the textarea MUST remain open in edit mode (no commit, no exit), its border MUST become `var(--danger)`, and an inline error message MUST be rendered immediately below the textarea showing the parser's error message (e.g. `Unexpected token } in JSON at position 47`). The error MUST be in `font-family: var(--font-mono); color: var(--danger); font-size: 11px`. Pressing Escape MUST still cancel the edit normally.

This applies identically in the grid cell editor (`EditableCell.tsx`) and the row inspector (`Inspector.tsx`).

#### Scenario: Valid JSON commits with canonical re-serialization

- **WHEN** the user types `{ "foo": "bar"  }  \n` (with extra whitespace) into a `jsonb` cell and presses Tab
- **THEN** the edit buffer receives the canonical string `{"foo":"bar"}` for that column
- **AND** the cell exits edit mode and renders the canonical form

#### Scenario: Invalid JSON keeps the editor open with an inline error

- **WHEN** the user types `{ "foo": "bar"` (missing closing brace) into a `jsonb` cell and presses Tab
- **THEN** the textarea stays mounted in edit mode
- **AND** its border is `var(--danger)`
- **AND** a one-line error message below the textarea shows the `JSON.parse` error text
- **AND** the edit buffer is NOT mutated for that column
- **AND** pressing Escape exits edit mode without committing

#### Scenario: Empty input commits as NULL

- **WHEN** the user clears a `jsonb` cell to empty (or whitespace only) and presses Tab
- **THEN** the edit buffer records a `null` write for that column (existing behavior)
- **AND** no parse error is shown

#### Scenario: Pasted smart-quote JSON is rejected at commit

- **WHEN** the user pastes `{"foo":"bar"}` (with smart quotes as outer delimiters) into a `jsonb` cell and presses Tab
- **THEN** `JSON.parse` fails with a syntax error
- **AND** the textarea stays open with the danger-border + inline error UI
- **AND** nothing is committed to the buffer or the backend

#### Scenario: Row inspector uses the same validation

- **WHEN** the user types invalid JSON into a `jsonb` field in the row inspector and tabs out
- **THEN** the same danger-border + inline error UI is rendered around the inspector field
- **AND** no commit reaches the buffer

### Requirement: Smart-quote warning chip on JSON edits

After a json/jsonb edit successfully passes `JSON.parse` validation, the frontend MUST scan the canonical (re-stringified) value for the presence of any of the following Unicode code points: U+201C (`"`), U+201D (`"`), U+2018 (`'`), U+2019 (`'`). If any are present, the frontend MUST render a small chip `⚠ Contains smart quotes` directly below the textarea while the editor is still mounted. The chip MUST be informational only — it MUST NOT block the commit, the commit MUST proceed normally, and the chip disappears when the editor closes (no persistent indicator on the dirty cell).

The chip MUST use `font-size: 11px`, `color: var(--warning)`, and a leading warning icon (Lucide `AlertTriangle` or equivalent at 11px).

#### Scenario: Smart quotes inside string content trigger a warning but commit succeeds

- **WHEN** the user pastes the string `{"name":"John “Doe” Smith"}` (smart quotes inside the string value, JSON itself is valid) into a `jsonb` cell and presses Tab
- **THEN** `JSON.parse` succeeds
- **AND** the canonical value sent to the buffer is `{"name":"John "Doe" Smith"}` (smart quotes preserved as valid string content)
- **AND** the smart-quote warning chip is shown below the textarea before commit
- **AND** the commit proceeds normally on Tab (chip is informational)

#### Scenario: Pure ASCII JSON shows no warning

- **WHEN** the user types `{"foo":"bar"}` (all ASCII quotes) into a `jsonb` cell
- **THEN** no smart-quote warning chip is rendered before or after commit

