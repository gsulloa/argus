## Why

Running a SQL statement in the SQL editor that Postgres rejects currently shows the user a useless error like `[22P02] db error` — the SQLSTATE is correct, but the message body is the literal string `db error` from `tokio_postgres::Error`'s top-level `Display` impl. The actual server-side message (`invalid input syntax for type json`, `column "foo" does not exist`, `syntax error at or near …`) lives on `tokio_postgres::Error::as_db_error()` and is dropped on the floor in `src-tauri/src/error.rs`.

This makes every Postgres error effectively undiagnosable from inside Argus. The user has to switch to `psql` or another client to learn what actually went wrong — defeating the whole point of an inspector/editor app.

## What Changes

- Fix `From<tokio_postgres::Error> for AppError` in `src-tauri/src/error.rs` so the `PostgresErrorBody.message` field carries the **server-side** message (and optional `DETAIL` / `HINT` lines), not the generic `db error` top-level string.
- When the error is a server-side `DbError` (`e.as_db_error().is_some()`), build the message from `db.message()` plus a single optional appended line per available field, in this order: `DETAIL: <db.detail()>`, `HINT: <db.hint()>`, `WHERE: <db.where_()>`. Each appended line is separated from the message by a single `\n`. Each appended line is skipped when the corresponding accessor returns `None`.
- When the error has no `DbError` payload (network/transport/timeout/protocol errors), fall back to the existing `e.to_string()` so we don't regress those cases.
- `code` and `position` extraction stay exactly as today — both already come from `as_db_error()` and work correctly.
- Unit tests cover three cases: (a) a `DbError` with message + detail + hint produces a multi-line message starting with the server message; (b) a `DbError` with only a message produces just the message; (c) a non-`DbError` falls back to the top-level `to_string()` (preserving the current contract for transport errors).

No frontend changes required. `ResultErrorBlock.tsx` already renders the message verbatim and the SQLSTATE chip — the message line will simply become useful.

No breaking changes. Wire shape of `AppError::Postgres` is unchanged (still `{ kind, message: { code, message, position } }`). Only the contents of the `message` string field change for Postgres-server-originated errors.

## Capabilities

### New Capabilities
_None._

### Modified Capabilities

- `postgres-sql-editor`: the existing **Error block with SQLSTATE and position** requirement says the panel "displays the error message verbatim" — that requirement is unchanged in shape, but a new sub-requirement and scenario lock in that the message the backend supplies is the Postgres server message (plus optional DETAIL/HINT/WHERE lines), not `tokio_postgres::Error`'s opaque top-level `Display` string. This guarantees the SQL editor's error block actually surfaces what Postgres said.

## Impact

- **Code**: `src-tauri/src/error.rs` — rewrite the `From<tokio_postgres::Error>` impl body. Add unit tests in the same file under `#[cfg(test)] mod tests`. ~30–50 lines of net change.
- **APIs**: no Tauri command signature changes. `AppError::Postgres` wire shape unchanged. Frontend `AppError`/`PostgresErrorBody` types in `src/platform/errors/AppError.ts` unchanged.
- **UI**: `ResultErrorBlock.tsx` automatically gets the better message. No CSS or layout changes.
- **Query history**: `query_history.error_message` (written via `record_history_err` in `sql.rs`) automatically picks up the better message — past rows keep their old content; new rows get the useful message. No migration needed.
- **Activity log**: `error.message` in `argus:activity-log` events likewise picks up the better message.
- **Dependencies**: none.
- **Risk**: low. The only behavior change is what string we put in one field; everything that consumes it already treats it as opaque text. The fallback path keeps the existing string for non-`DbError` errors so timeout/network error messages don't regress. Tests pin both branches.
- **Out of scope**: changing how the frontend renders multi-line error messages (today `ResultErrorBlock` renders the message in a single `<div>`; multi-line CSS may need a follow-up to preserve line breaks visually — see design.md).
