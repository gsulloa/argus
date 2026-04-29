## MODIFIED Requirements

### Requirement: Read-only enforcement at the module boundary

When a connection's `params.read_only` is `true`, every Postgres session acquired from its pool SHALL execute `SET SESSION default_transaction_read_only = on; SET SESSION transaction_read_only = on;` immediately after handshake. The Postgres module SHALL provide two execution helpers — `executeQuery` (always allowed) and `executeMutation` (rejected at the Rust boundary if the pool is read-only) — and MUST NOT expose a generic raw-pool accessor that bypasses these helpers.

`executeMutation(connection_id, sql, params)` MUST be implemented as a real, callable helper (not a stub or contract-only). It MUST:

1. Look up the pool for `connection_id` in `PgPoolRegistry`. Return `AppError::NotFound` if absent.
2. Check the pool's `read_only` flag BEFORE acquiring a client. If `true`, return `AppError::Validation { message: "connection is read-only" }` without dispatching any statement to the wire.
3. Acquire a client from the pool, execute the statement with bound `params`, and return the row count or affected-rows count.
4. Honor the same 15s timeout + cancel-token pattern used by `executeQuery`.

Higher-level commands that need transactional control (e.g. `postgres_apply_table_edits`) MAY acquire a client directly from the pool to manage the transaction lifetime explicitly — but MUST first perform the same `read_only` check that `executeMutation` performs.

#### Scenario: Mutation rejected before reaching the wire

- **WHEN** any module calls `executeMutation(id, "UPDATE t SET x = 1", [])` for a connection with `read_only: true`
- **THEN** the helper returns `AppError::Validation` with message `"connection is read-only"` and no SQL is sent to the server

#### Scenario: Mutation executes on writable connection

- **WHEN** any module calls `executeMutation(id, "UPDATE t SET x = $1 WHERE id = $2", ["a", 1])` for a writable connection
- **THEN** the statement is dispatched, the bound parameters are used, and the helper returns the affected-row count

#### Scenario: Read query allowed on read-only connection

- **WHEN** any module calls `executeQuery(id, "SELECT 1", [])` for a connection with `read_only: true`
- **THEN** the query executes successfully

#### Scenario: Mutation rejected by server if it slips through

- **WHEN** a stored procedure or trigger fires a write on a read-only session
- **THEN** Postgres rejects it with SQLSTATE 25006 (`read_only_sql_transaction`) and the error surfaces as `AppError::Postgres` with that code

#### Scenario: Transactional caller skips executeMutation but still checks read-only

- **WHEN** `postgres_apply_table_edits` runs against a connection with `read_only: true`
- **THEN** the command returns `AppError::Validation { message: "connection is read-only" }` BEFORE any `BEGIN` is dispatched
