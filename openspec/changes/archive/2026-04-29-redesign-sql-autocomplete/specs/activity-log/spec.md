## MODIFIED Requirements

### Requirement: Activity log entry payload

The system SHALL define a typed payload `ActivityLogEntry` emitted from the Rust backend after every Postgres command (success or failure). The payload MUST be serialized to the frontend as JSON with snake_case keys and SHALL contain:

- `v: number` — schema version (initial value `1`).
- `id: string` — UUID identifying this entry.
- `timestamp_unix_ms: number` — wall-clock time at emission.
- `connection_id: string | null` — UUID of the Postgres connection the operation targeted, or `null` when the operation has no bound connection (e.g. `postgres_test_connection` for unsaved params).
- `kind: string` — one of `"test_connection"`, `"connect"`, `"disconnect"`, `"list_schemas"`, `"list_relations"`, `"list_structure"`, `"list_table_extras"`, `"list_columns_bulk"`, `"query_table"`, `"count_table"`, `"apply_edits"`, `"run_sql"`.
- `origin: "auto" | "user"` — whether Argus initiated the call internally (`auto`) or the user did (`user`).
- `duration_ms: number` — elapsed wall time in Rust from command entry to emission.
- `status: "ok" | "err"` — whether the command returned a successful result or an error.
- `sql: string | null` — full SQL text when the command issued one (`query_table`, `count_table`, `run_sql`); for `apply_edits`, the concatenation of every per-op SQL statement separated by `"; "`, truncated to 4000 characters with a trailing `…` when needed; for `run_sql`, the exact SQL of the single statement that was executed (one entry per statement, even within a multi-statement run); `null` for catalog-only or lifecycle commands (including `list_columns_bulk`).
- `params: string[] | null` — bind parameters as `Debug`-formatted strings, each truncated to 200 characters with a trailing `…` marker on truncation. `null` when no parameters were bound.
- `metric: { kind: "rows", value: number } | { kind: "count", value: number } | { kind: "affected", value: number } | { kind: "server_version", value: string } | { kind: "items", value: number } | null`.
- `error: { message: string, code: string | null } | null` — populated when `status === "err"`.

#### Scenario: Bulk columns command emits an entry with item count

- **WHEN** `postgres_list_columns_bulk` returns successfully with 8 relations totalling 47 columns
- **THEN** an entry is emitted with `kind: "list_columns_bulk"`, `status: "ok"`, `origin: "auto"`, `sql: null`, `params: null`, `metric: { kind: "items", value: 47 }`, `error: null`

#### Scenario: Successful query emits a complete entry

- **WHEN** `postgres_query_table` returns successfully with 42 rows in 4 ms after issuing `SELECT … FROM "public"."users"`
- **THEN** an entry is emitted with `kind: "query_table"`, `status: "ok"`, `sql` containing the issued SELECT, `params` matching the bound values, `duration_ms` ≥ 4, `metric: { kind: "rows", value: 42 }`, `error: null`, `v: 1`

#### Scenario: Failing command emits an entry with error

- **WHEN** `postgres_count_table` fails with `AppError::Postgres { code: Some("42P01"), message }`
- **THEN** an entry is emitted with `status: "err"`, `error: { message, code: "42P01" }`, `metric: null`, `duration_ms` measuring time until failure

#### Scenario: Lifecycle command without SQL emits null sql/params

- **WHEN** `postgres_connect` returns successfully
- **THEN** the emitted entry has `sql: null`, `params: null`, and `metric: { kind: "server_version", value: "PostgreSQL 16.x ..." }`

### Requirement: Per-kind metric mapping

Each command kind SHALL populate `metric` on success according to a fixed mapping:

| Kind | Metric on success |
|---|---|
| `query_table` | `{ kind: "rows", value: <row count> }` |
| `count_table` | `{ kind: "count", value: <count i64> }` |
| `connect` | `{ kind: "server_version", value: <serverVersion string> }` |
| `test_connection` | `{ kind: "server_version", value: <serverVersion string> }` (only when ok) |
| `list_schemas` | `{ kind: "items", value: <schemas length> }` |
| `list_relations` | `{ kind: "items", value: <tables + views + materialized_views> }` |
| `list_structure` | `{ kind: "items", value: <functions + types + extensions counts, treating None as 0> }` |
| `list_table_extras` | `{ kind: "items", value: <indexes + triggers, None → 0> }` |
| `list_columns_bulk` | `{ kind: "items", value: <total columns across all relations> }` |
| `apply_edits` | `{ kind: "rows", value: <total rows affected across all ops> }` |
| `run_sql` | `{ kind: "rows", value: <row count> }` for `RunSqlResult::Rows`; `{ kind: "affected", value: <affected_rows> }` for `RunSqlResult::Affected` |
| `disconnect` | `null` |

On failure (`status: "err"`), `metric` MUST be `null` regardless of kind.

#### Scenario: Bulk columns reports total cols across relations

- **WHEN** `postgres_list_columns_bulk` returns 5 relations with 4, 7, 12, 8, 16 columns respectively
- **THEN** the emitted entry has `metric: { kind: "items", value: 47 }`

#### Scenario: Connect carries the server version

- **WHEN** `postgres_connect` succeeds against a server reporting `PostgreSQL 16.2`
- **THEN** the emitted entry has `metric: { kind: "server_version", value: "PostgreSQL 16.2" }`
