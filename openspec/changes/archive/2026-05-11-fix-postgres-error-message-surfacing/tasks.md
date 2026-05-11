## 1. Investigate tokio_postgres test surface

- [x] 1.1 Confirm the pinned `tokio-postgres` version in `src-tauri/Cargo.toml` and check which constructors for `tokio_postgres::Error` / `DbError` are reachable from a `#[cfg(test)]` module (look for `DbError::parse`, `Error::__private_api_*`, or any `pub(crate)`/doc-gated helper).
- [x] 1.2 If no public constructor exists, sketch a minimal wire-format `ErrorResponse` byte buffer (Postgres protocol §53.7) that carries `Severity=ERROR`, `Code=22P02`, `Message=…`, `Detail=…`, `Hint=…` and confirm `DbError::parse` accepts it.
- [ ] 1.3 If even `DbError::parse` isn't reachable, fall back to a single `#[ignore]`'d integration test against a real Postgres (using the existing dev container pattern) — and document the manual smoke step in the PR template.

## 2. Backend: rewrite the From impl

- [x] 2.1 In `src-tauri/src/error.rs`, replace the body of `impl From<tokio_postgres::Error> for AppError` so that when `e.as_db_error()` is `Some(db)` the `message` field is built as `db.message()` joined by `\n` with optional `"DETAIL: …"`, `"HINT: …"`, `"WHERE: …"` lines (each skipped when the accessor returns `None`).
- [x] 2.2 Keep the existing `code` extraction (`e.code()…or_else(as_db_error)`) and `position` extraction (`as_db_error().position()`) unchanged.
- [x] 2.3 When `e.as_db_error()` is `None`, fall back to `e.to_string()` for the message — preserving today's behavior for transport/timeout/protocol errors.
- [x] 2.4 Pull the message-assembly logic into a small private helper `fn build_pg_message(e: &tokio_postgres::Error) -> String` so it's directly testable without constructing a full `AppError`.

## 3. Backend: unit tests

- [x] 3.1 Add `#[cfg(test)] mod tests` to `src-tauri/src/error.rs` (or extend existing one) with three tests using whatever constructor was chosen in task 1:
  - `db_error_with_detail_and_hint_assembles_multiline_message`: asserts the `message` field equals `"<server msg>\nDETAIL: <detail>\nHINT: <hint>"`.
  - `db_error_message_only_has_no_extra_lines`: asserts the `message` field equals exactly the server message, with no trailing `\n`.
  - `non_db_error_falls_back_to_display`: asserts the `message` field equals `e.to_string()` for a non-`DbError` error (timeout or connection-closed flavor).
- [x] 3.2 Run `cargo test -p argus error::tests` (or the project's standard `cargo test` invocation) and confirm all three pass locally.

## 4. End-to-end verification

- [x] 4.1 Start the dev app (`pnpm tauri dev`), connect to a Postgres with a `jsonb` column that contains malformed text after a replace (or just run a `SELECT 'not json'::jsonb` to force a `22P02`).
- [x] 4.2 Confirm the result panel's error block shows the real server message (e.g. `invalid input syntax for type json …`) and not the literal `db error`, with the SQLSTATE chip showing `22P02`.
- [x] 4.3 Trigger a constraint violation (e.g. `INSERT … VALUES (existing_pk)`) and confirm the `DETAIL:` line renders on its own line below the message.
- [ ] 4.4 Trigger a connection-closed scenario (kill the Postgres process mid-query, or wait out a long network drop) and confirm the message is still a meaningful kind tag from `to_string()` (no `panic`, no empty string).

## 5. Activity log and history smoke

- [ ] 5.1 After triggering a failed query in step 4.2, open the Activity panel and confirm the entry's error message is the new server message.
- [ ] 5.2 Open the query history view (if reachable via the UI) and confirm the failed row's stored error message matches the new server message.

## 6. Ship

- [x] 6.1 `cargo fmt` and `cargo clippy -- -D warnings` on `src-tauri/`.
- [ ] 6.2 Capture before/after screenshots of the SQL editor error block for the PR description (use the OP's `REPLACE(...)::jsonb` query as the canonical example).
- [ ] 6.3 Open a PR against `origin/gsulloa/beta-release` with a short summary, the screenshots, and a checklist mirroring the scenarios in `specs/postgres-sql-editor/spec.md`.
