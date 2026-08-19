## MODIFIED Requirements

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

On failure (`status: "err"`), `metric` MUST be `null` regardless of kind. Note that `affected` is a metric variant introduced for `run_sql`; it is semantically distinct from `count` (which is reserved for the explicit `SELECT COUNT(*)` issued by `count_table`) and from `rows` (which is reserved for actual returned row sets).

For a truncated `run_sql`, the `rows` value is the number of rows actually returned — i.e. that
statement's **effective row cap** as resolved by the `sql-result-row-cap` capability, which is no
longer a fixed 10,000. It follows the configured `sql.rowCap` setting and any statement-level
limit that raised the cap.

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

#### Scenario: Bulk columns reports total cols across relations

- **WHEN** `postgres_list_columns_bulk` returns 5 relations with 4, 7, 12, 8, 16 columns respectively
- **THEN** the emitted entry has `metric: { kind: "items", value: 47 }`

#### Scenario: Run sql DDL reports zero affected

- **WHEN** `postgres_run_sql` runs `CREATE TABLE foo (id int)` and returns `{ kind: "affected", command_tag: "CREATE TABLE", affected_rows: 0 }`
- **THEN** the emitted entry has `metric: { kind: "affected", value: 0 }` and `status: "ok"`

#### Scenario: Run sql truncated SELECT reports the cap as rows

- **WHEN** `postgres_run_sql` returns `kind: "rows"` truncated at the default cap of 10,000
- **THEN** the emitted entry has `metric: { kind: "rows", value: 10000 }`

#### Scenario: Run sql truncated SELECT under a raised cap reports the raised value

- **WHEN** `sql.rowCap` is `50000` and `postgres_run_sql` returns `kind: "rows"` truncated at that cap
- **THEN** the emitted entry has `metric: { kind: "rows", value: 50000 }`

#### Scenario: Run sql honouring an explicit LIMIT reports the returned rows

- **WHEN** `postgres_run_sql` runs `SELECT * FROM t LIMIT 30000` and returns 30,000 rows with `truncated: false`
- **THEN** the emitted entry has `metric: { kind: "rows", value: 30000 }`
