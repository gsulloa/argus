## ADDED Requirements

### Requirement: Apply command is the shared write path for ad-hoc result edits

`postgres_apply_table_edits` SHALL be the single write path for **every** in-app
cell edit against a Postgres relation — the table viewer's data grid and the SQL
editor's result grid alike. No parallel write command, and no SQL-string
construction outside `build_edit_sql`, may be introduced for the SQL editor.

The command already resolves the relation's primary key and full column list
server-side at commit time, so a caller MAY submit `update` ops against a
**partial projection**: `changes` needs only the columns the caller wants written,
and `pk` needs only the relation's PK columns. Columns absent from the caller's
result set MUST NOT be touched. The command MUST continue to reject an op naming a
column that does not exist on the relation with `AppError::Validation`.

Callers MUST address `changes` and `pk` by the relation's **base column names**. A
caller displaying aliased columns is responsible for translating aliases back to
base column names before building the op (see `sql-result-editability`, "Editable
cells are addressed by base column and primary key").

Because PK and column metadata are re-read inside the apply transaction, a relation
that was altered or dropped between the time a result was fetched and the time the
user saves MUST fail with the Postgres error surfaced through the existing
`op_failed` / `AppError` paths — never with a silent partial write.

#### Scenario: Update against a partial projection touches only the named columns

- **WHEN** the caller submits `{ kind: "update", pk: { id: 7 }, changes: { email: "ana@example.com" } }` against `public.users`, which also has `name` and `created_at` columns
- **THEN** the issued SQL sets only `"email"`
- **AND** `name` and `created_at` retain their existing values

#### Scenario: Unknown column in a partial projection is rejected

- **WHEN** the caller submits `{ kind: "update", pk: { id: 7 }, changes: { nickname: "x" } }` and `users` has no `nickname` column
- **THEN** the command returns `AppError::Validation` naming `nickname`
- **AND** no `BEGIN` is dispatched

#### Scenario: Relation dropped between fetch and save fails loudly

- **WHEN** a SQL editor result was fetched from `public.users`, the table is dropped, and the user then saves a pending edit
- **THEN** the command fails with a Postgres error surfaced to the caller
- **AND** no partial write occurs

#### Scenario: Read-only enforcement applies identically to the SQL editor caller

- **WHEN** the SQL editor result grid attempts to save against a connection whose pool is `read_only: true`
- **THEN** the command returns `AppError::Validation` with message containing `"read-only"`
- **AND** no `BEGIN` is dispatched

#### Scenario: Activity log does not distinguish the caller

- **WHEN** a save originates from the SQL editor result grid and commits two ops affecting two rows
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "apply_edits"`, `status: "ok"`, `origin: "user"`, `metric: { kind: "rows", value: 2 }`
