## Context

The Postgres error path in Argus has two layers:

1. **Rust backend** (`src-tauri/src/error.rs`) — converts `tokio_postgres::Error` into `AppError::Postgres(PostgresErrorBody { code, message, position })` via the `From` impl at lines 83–102. This is the only place a Postgres error is normalized into the app's error envelope.
2. **Frontend** (`src/platform/errors/AppError.ts`, `src/modules/postgres/sql/ResultErrorBlock.tsx`) — deserializes the envelope and renders `message` verbatim in `<div class="errorMessage">`, with `code` shown as a chip and `position` driving a `Show in editor` button.

The bug lives in step 1. The current impl reads:

```rust
impl From<tokio_postgres::Error> for AppError {
    fn from(e: tokio_postgres::Error) -> Self {
        let code = e
            .code()
            .map(|c| c.code().to_string())
            .or_else(|| e.as_db_error().map(|d| d.code().code().to_string()));
        let position = e.as_db_error().and_then(|d| match d.position() {
            Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p as i32),
            Some(tokio_postgres::error::ErrorPosition::Internal { position, .. }) => {
                Some(*position as i32)
            }
            None => None,
        });
        AppError::Postgres(PostgresErrorBody {
            code,
            message: e.to_string(),   // <-- BUG: yields "db error"
            position,
        })
    }
}
```

`tokio_postgres::Error`'s top-level `Display` impl is a generic kind tag like `"db error"`, `"connection closed"`, `"timeout waiting for connection"`. The Postgres-server-supplied message lives one level down on `e.as_db_error()`. The `code` and `position` extractions both already reach in there — only `message` is wrong.

Result: the user sees `[22P02] db error` for every server-side rejection, regardless of whether Postgres said `"invalid input syntax for type json"`, `"column \"foo\" does not exist"`, `"duplicate key value violates unique constraint"`, etc. Every server error becomes a black box.

The Rust API on `tokio_postgres::error::DbError` exposes (at minimum) `message()`, `detail()`, `hint()`, `where_()`, and `code()`. The first three are the standard Postgres error response fields a `psql` user expects to see (`ERROR: …`, `DETAIL: …`, `HINT: …`).

## Goals / Non-Goals

**Goals:**
- Surface the Postgres-server error message in the SQL editor's error block instead of `db error`.
- Preserve `DETAIL` and `HINT` content (the two most useful auxiliary fields — e.g. constraint violations include the offending row in `DETAIL`, type errors often suggest fixes in `HINT`).
- Keep the wire shape of `AppError::Postgres` and `PostgresErrorBody` unchanged — only the contents of the `message` string change.
- Keep transport-layer error messages (timeout, broken pipe, TLS errors) intact — those don't have a `DbError` and `e.to_string()` is the right answer for them today.
- Lock the behavior in with unit tests on both branches (DbError-present, DbError-absent).

**Non-Goals:**
- Frontend changes. `ResultErrorBlock.tsx` already renders the message verbatim, and `.errorMessage` in `ResultPanel.module.css` already has `white-space: pre-wrap` (line 131) so embedded `\n` chars render correctly.
- Surfacing `SCHEMA`, `TABLE`, `COLUMN`, `DATATYPE`, `CONSTRAINT`, `FILE`, `LINE`, `ROUTINE` fields (`DbError` exposes them too). Useful for tooling but adds noise to the error block; revisit if users ask.
- Internationalization. `DETAIL:` / `HINT:` / `WHERE:` are emitted in English (matching `psql` conventions).
- Restructuring `PostgresErrorBody` to carry `detail` / `hint` as separate fields. That would be cleaner for the frontend but expands the wire shape; for V1 we keep `message` as a single newline-joined string so no frontend changes are required.

## Decisions

### Build the message from `db.message()` + appended fields, single string

When `e.as_db_error()` returns `Some(db)`, the message string is built as:

```
{db.message()}
DETAIL: {db.detail()}        // only if Some
HINT: {db.hint()}            // only if Some
WHERE: {db.where_()}         // only if Some
```

Joined by `\n`. Same convention `psql` uses (and many Postgres tools / Sentry adapters). The frontend's `.errorMessage` rule already has `white-space: pre-wrap`, so the line breaks render visually.

**Alternative considered**: return separate `detail`/`hint`/`where_` fields on `PostgresErrorBody` and let the frontend lay them out as labeled rows. Rejected for V1 because (a) it expands the public wire contract and forces a coordinated frontend change, and (b) the newline-joined form already reads well in the existing error block. Revisit once we have a clearer use case (e.g. linkifying constraint names).

**Alternative considered**: only return `db.message()`, drop DETAIL/HINT. Rejected because constraint violations (`23505 unique_violation`) lean heavily on `DETAIL` to communicate which row caused the conflict — losing that would only solve half the bug.

### Branch on `e.as_db_error().is_some()`, not on `e.code().is_some()`

`tokio_postgres::Error::code()` returns `Some(SqlState)` for some non-`DbError` cases (e.g. it can be set on certain types of errors that carry a code without a full `DbError` payload). What we care about for the message rebuild is specifically whether there's a server-side `DbError` to read from. Branch on `as_db_error()` directly.

### Keep `e.to_string()` as the fallback message

Network errors (`tokio_postgres::Error` with kind `Io` or `Closed`), TLS handshake failures, protocol errors, and timeouts produced inside `tokio_postgres` itself have no `DbError`. For those, `e.to_string()` continues to be the right answer — it gives a meaningful kind ("connection closed", "timeout waiting for connection", etc.). Pinning this in a test prevents future "let's simplify" refactors from regressing it.

### No frontend rendering changes

`ResultErrorBlock.tsx:34` renders `<div className={styles.errorMessage}>{message}</div>`. With `white-space: pre-wrap`, embedded `\n` chars become visual line breaks. No JSX or CSS change required. Verified via reading `src/modules/postgres/sql/ResultPanel.module.css:129–133`.

### Test plan (Rust-only)

Three unit tests in `src-tauri/src/error.rs` under `#[cfg(test)]`:

1. `db_error_with_detail_and_hint_assembles_multiline_message` — construct a `tokio_postgres::Error` from a `DbError` carrying message+detail+hint, convert via `AppError::from`, assert the `message` field starts with the server message and contains `DETAIL: …` and `HINT: …` lines.
2. `db_error_message_only_has_no_extra_lines` — `DbError` with only `message()` set → result equals exactly `db.message()`.
3. `non_db_error_falls_back_to_display` — a transport error (e.g. a synthetic error with no `DbError`) → result message equals the top-level `Display` (preserves current behavior for network errors).

Because `tokio_postgres::Error` is constructed via internal `__private` paths, the tests will use whatever construction helper is available (`tokio_postgres::error::Error::__private_api_*` or a small fixture helper). If no public constructor is available in our pinned version, the tests build a `DbError` via its public `parse(&[u8])` helper from a wire-format byte buffer that mirrors a real ErrorResponse message — same approach `tokio-postgres`'s own test suite uses. The exact mechanism is an implementation detail nailed down in `tasks.md`.

## Risks / Trade-offs

- **Risk**: `tokio_postgres::Error` may not expose a stable public constructor for tests in our pinned version. → **Mitigation**: the `DbError::parse` API takes raw wire bytes and is documented as test-friendly; if even that doesn't exist on our version, fall back to an integration-style test that round-trips through a real connection in a `#[ignore]`'d test, plus a manual smoke test in the PR description (run the OP's UPDATE and screenshot the new error). Decision deferred to the implementer in the first task.

- **Risk**: messages containing `\n` flow through `query_history.error_message` and `argus:activity-log` events. The history viewer and activity panel today likely render the message as a single line — multi-line messages may visually truncate or wrap awkwardly. → **Mitigation**: these are read-only display surfaces with `font-family: monospace`; visual regression is at worst aesthetic. If it bothers anyone, follow up with `white-space: pre-wrap` on those views. Not blocking.

- **Risk**: server messages can be long (e.g. `DETAIL` for a `23505` includes the full row). → **Mitigation**: `.errorBlock` is scrollable within the result panel (the panel's `.body` already has `overflow: auto`). No cap needed.

- **Trade-off**: keeping `message` as a single joined string vs. structured fields. We're choosing the cheaper path (no contract change) at the cost of a future migration if/when we want clickable constraint names. Acceptable — the alternative would gate a one-line bug fix behind a frontend refactor.
