## ADDED Requirements

### Requirement: Postgres server message surfaces verbatim in error envelope

When the backend converts a `tokio_postgres::Error` into `AppError::Postgres`, the `PostgresErrorBody.message` field MUST carry the **Postgres-server-supplied** error message — not `tokio_postgres::Error`'s top-level `Display` string. Specifically:

- When `tokio_postgres::Error::as_db_error()` returns `Some(db)`, the `message` field MUST be built by joining the following with a single `\n`, in order, omitting any line whose accessor returns `None`:
  1. `db.message()` (always present; this is the first line).
  2. `"DETAIL: " + db.detail()` when `db.detail()` is `Some`.
  3. `"HINT: " + db.hint()` when `db.hint()` is `Some`.
  4. `"WHERE: " + db.where_()` when `db.where_()` is `Some`.
- When `tokio_postgres::Error::as_db_error()` returns `None` (transport/protocol/timeout errors with no server-side payload), the `message` field MUST fall back to `tokio_postgres::Error::to_string()` so transport diagnostics are preserved.

The `code` and `position` fields of `PostgresErrorBody` are unchanged: `code` MUST be the SQLSTATE extracted via the existing `e.code()` / `e.as_db_error().code()` chain, and `position` MUST be the 1-based offset extracted via the existing `e.as_db_error().position()` chain.

The wire shape of `AppError::Postgres` (`{ kind: "Postgres", message: { code, message, position } }`) is unchanged. Only the contents of the inner `message` string change.

This requirement applies to every Tauri command that converts a `tokio_postgres::Error` via the standard `From` impl, including `postgres_run_sql`, `postgres_run_sql_many`, structured-edit, structured-filter, and schema/columns commands.

#### Scenario: Invalid jsonb cast surfaces the server message

- **WHEN** the user runs `UPDATE market.product SET metadata = REPLACE(metadata::text, 'a', 'b')::jsonb` in the SQL editor and Postgres rejects the result because the produced text is not valid JSON
- **THEN** `AppError::Postgres.message.code` is `"22P02"`
- **AND** `AppError::Postgres.message.message` starts with the Postgres server message (for example `"invalid input syntax for type json"`) and is **NOT** the literal string `"db error"`
- **AND** the SQL editor's error block renders that server message verbatim

#### Scenario: DETAIL and HINT are appended on separate lines

- **WHEN** Postgres returns an error carrying a `DETAIL` and a `HINT` (for example, a unique-constraint violation that includes the offending row in `DETAIL`)
- **THEN** `AppError::Postgres.message.message` consists of the server message on the first line, `"DETAIL: <detail text>"` on the second line, and `"HINT: <hint text>"` on the third line, separated by `\n`
- **AND** the SQL editor's error block (which already uses `white-space: pre-wrap` on `.errorMessage`) renders all three lines visibly

#### Scenario: Server message without DETAIL or HINT is single-line

- **WHEN** Postgres returns an error with only a `MESSAGE` field (for example, a simple `syntax error at or near "SELEC"`)
- **THEN** `AppError::Postgres.message.message` is exactly the server message with no trailing newline and no `DETAIL:` / `HINT:` / `WHERE:` lines

#### Scenario: Transport errors preserve current diagnostic text

- **WHEN** a query fails because the connection was closed mid-flight (a `tokio_postgres::Error` whose `as_db_error()` returns `None`)
- **THEN** `AppError::Postgres.message.message` falls back to `tokio_postgres::Error::to_string()` (a diagnostic kind tag such as `"connection closed"` or `"db error: …"`)
- **AND** `AppError::Postgres.message.code` is `None` (no SQLSTATE available)

#### Scenario: Activity log and query history pick up the server message

- **WHEN** a SQL run fails with a Postgres server error
- **THEN** the `argus:activity-log` event's `error.message` is the same server-message-derived string surfaced to the SQL editor
- **AND** the corresponding `query_history` row's `error_message` column is that same string
- **AND** the `error_code` column is the SQLSTATE
