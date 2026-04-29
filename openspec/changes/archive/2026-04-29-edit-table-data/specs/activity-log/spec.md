## MODIFIED Requirements

### Requirement: Activity log entry payload

The system SHALL define a typed payload `ActivityLogEntry` emitted from the Rust backend after every Postgres command (success or failure). The payload MUST be serialized to the frontend as JSON with snake_case keys and SHALL contain:

- `v: number` — schema version (initial value `1`).
- `id: string` — UUID identifying this entry.
- `timestamp_unix_ms: number` — wall-clock time at emission.
- `connection_id: string | null` — UUID of the Postgres connection the operation targeted, or `null` when the operation has no bound connection (e.g. `postgres_test_connection` for unsaved params).
- `kind: string` — one of `"test_connection"`, `"connect"`, `"disconnect"`, `"list_schemas"`, `"list_relations"`, `"list_structure"`, `"list_table_extras"`, `"query_table"`, `"count_table"`, `"apply_edits"`.
- `origin: "auto" | "user"` — whether Argus initiated the call internally (`auto`) or the user did (`user`).
- `duration_ms: number` — elapsed wall time in Rust from command entry to emission.
- `status: "ok" | "err"` — whether the command returned a successful result or an error.
- `sql: string | null` — full SQL text when the command issued one (`query_table`, `count_table`); for `apply_edits`, the concatenation of every per-op SQL statement separated by `"; "`, truncated to 4000 characters with a trailing `…` when needed; `null` for catalog-only, lifecycle, or preview commands.
- `params: string[] | null` — bind parameters as `Debug`-formatted strings, each truncated to 200 characters with a trailing `…` marker on truncation. `null` when no parameters were bound; `null` for `apply_edits` (per-op params would balloon and the SQL field carries enough signal).
- `metric: { kind: "rows", value: number } | { kind: "count", value: number } | { kind: "server_version", value: string } | { kind: "items", value: number } | null` — per-op secondary metric (see "Per-kind metric mapping").
- `error: { message: string, code: string | null } | null` — populated when `status === "err"`. `code` carries the SQLSTATE when present (forwarded from `AppError::Postgres`).

#### Scenario: Successful query emits a complete entry

- **WHEN** `postgres_query_table` returns successfully with 42 rows in 4 ms after issuing `SELECT … FROM "public"."users"`
- **THEN** an entry is emitted with `kind: "query_table"`, `status: "ok"`, `sql` containing the issued SELECT, `params` matching the bound values, `duration_ms` ≥ 4, `metric: { kind: "rows", value: 42 }`, `error: null`, `v: 1`

#### Scenario: Failing command emits an entry with error

- **WHEN** `postgres_count_table` fails with `AppError::Postgres { code: Some("42P01"), message }`
- **THEN** an entry is emitted with `status: "err"`, `error: { message, code: "42P01" }`, `metric: null`, `duration_ms` measuring time until failure

#### Scenario: Lifecycle command without SQL emits null sql/params

- **WHEN** `postgres_connect` returns successfully
- **THEN** the emitted entry has `sql: null`, `params: null`, and `metric: { kind: "server_version", value: "PostgreSQL 16.x ..." }`

#### Scenario: Apply edits concatenates SQL and nulls params

- **WHEN** `postgres_apply_table_edits` succeeds with 3 ops affecting 3 rows
- **THEN** an entry is emitted with `kind: "apply_edits"`, `status: "ok"`, `sql` containing all three statements separated by `"; "`, `params: null`, `metric: { kind: "rows", value: 3 }`

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
| `apply_edits` | `{ kind: "rows", value: <total rows affected across all ops> }` |
| `disconnect` | `null` |

On failure (`status: "err"`), `metric` MUST be `null` regardless of kind.

#### Scenario: Connect carries the server version

- **WHEN** `postgres_connect` succeeds against a server reporting `PostgreSQL 16.2`
- **THEN** the emitted entry has `metric: { kind: "server_version", value: "PostgreSQL 16.2" }`

#### Scenario: List structure with one failed sub-query still reports items

- **WHEN** `postgres_list_structure` returns `{ functions: None, types: Some(7), extensions: Some(3), failures: [{ kind: "functions", … }] }`
- **THEN** the emitted entry has `status: "ok"` and `metric: { kind: "items", value: 10 }` (None counted as 0)
- **AND** `error` remains `null` because the command itself returned `Ok`

#### Scenario: Apply edits reports total rows affected

- **WHEN** `postgres_apply_table_edits` succeeds with 2 updates (1 row each) and 1 delete (1 row), 3 rows total
- **THEN** the emitted entry has `metric: { kind: "rows", value: 3 }`
