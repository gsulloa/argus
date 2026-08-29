## ADDED Requirements

### Requirement: Result editability payload

Every engine that returns an ad-hoc rows-shaped SQL result SHALL be able to
describe whether that result is safely writable, using a single discriminated
`ResultEditability` payload carried alongside `columns` and `rows`. The payload is
serialised with a `status` discriminant and snake_case keys:

- `{ status: "editable", schema: string, relation: string, pk_columns: string[], pk_column_indexes: number[], column_sources: (string | null)[], enums: { [base_column: string]: string[] } }`
- `{ status: "not_editable", reason: EditBlockReason }`

Field contracts for the `editable` variant:

- `schema` / `relation` MUST identify the single base relation every projected
  column resolves to, fully qualified, resolved from catalog identity rather than
  from the text of the statement.
- `pk_columns` MUST list the relation's primary-key columns in declared order.
- `pk_column_indexes` MUST have the same length as `pk_columns` and MUST give, for
  each PK column, the index into `columns` of the result column that projects it.
- `column_sources` MUST have the same length as `columns`. Entry `i` is the base
  relation column name that result column `i` projects, or `null` when result
  column `i` is a computed expression, a literal, an aggregate, or otherwise not a
  plain column reference. Aliases MUST NOT leak into `column_sources`: a result
  column declared `SELECT id AS pk` has `columns[i].name === "pk"` and
  `column_sources[i] === "id"`.
- `enums` MUST be keyed by **base** column name (matching `column_sources`
  entries), not by result column name.

`ResultEditability` is descriptive only. It MUST NOT be treated by the backend as
authorisation: the write command performs its own read-only and validation checks.

#### Scenario: Simple projection of a keyed table is editable

- **WHEN** the user runs `SELECT id, email FROM users WHERE active` against a table `public.users` with PK `(id)`
- **THEN** the result carries `{ status: "editable", schema: "public", relation: "users", pk_columns: ["id"], pk_column_indexes: [0], column_sources: ["id", "email"], enums: {} }`

#### Scenario: Aliased columns report the base column name

- **WHEN** the user runs `SELECT id AS pk, email AS mail FROM users`
- **THEN** `columns` names are `["pk", "mail"]`
- **AND** `column_sources` is `["id", "email"]`
- **AND** `pk_column_indexes` is `[0]`

#### Scenario: Mixed projection marks only the computed column as unsourced

- **WHEN** the user runs `SELECT id, email, upper(email) AS shout FROM users`
- **THEN** `column_sources` is `["id", "email", null]`
- **AND** the result is still `status: "editable"`

#### Scenario: Enum labels are keyed by base column name

- **WHEN** the user runs `SELECT id, status AS s FROM users` and `users.status` is an enum with labels `['new','active']`
- **THEN** `enums` is `{ "status": ["new", "active"] }`
- **AND** `enums` does NOT contain the key `"s"`

### Requirement: Editability block reasons

When a result is not writable, `ResultEditability` SHALL carry a machine-readable
`reason` drawn from a closed set. The set is:

| `reason` | Meaning |
| --- | --- |
| `no_base_table` | No result column resolves to a relation column (aggregate-only, literal-only, `EXPLAIN`, `SHOW`, function result), or the provenance lookup could not be completed. |
| `multiple_tables` | Result columns resolve to more than one distinct relation (a join, a `UNION`, a multi-relation CTE projection). |
| `not_a_table` | All columns resolve to a single relation, but its `relkind` is not an ordinary or partitioned table (view, materialized view, foreign table, index, sequence). |
| `no_primary_key` | The resolved relation has no primary key. |
| `pk_not_selected` | The resolved relation has a primary key, but at least one PK column is absent from the projection. |
| `duplicate_projection` | Two or more result columns resolve to the same base column. |

The reason MUST be reported without free-form text — user-facing copy is the
consumer's responsibility. Consumers MAY synthesise additional local-only reasons
(for example "the connection is read-only" or "this is a multi-statement run") from
state they already hold; those local reasons MUST NOT be transmitted as
`EditBlockReason` values.

#### Scenario: Aggregate-only result has no base table

- **WHEN** the user runs `SELECT count(*) FROM users`
- **THEN** the result carries `{ status: "not_editable", reason: "no_base_table" }`

#### Scenario: Join across two tables blocks editing

- **WHEN** the user runs `SELECT u.id, o.total FROM users u JOIN orders o ON o.user_id = u.id`
- **THEN** the result carries `{ status: "not_editable", reason: "multiple_tables" }`

#### Scenario: View is not editable

- **WHEN** the user runs `SELECT * FROM active_users_view`
- **THEN** the result carries `{ status: "not_editable", reason: "not_a_table" }`

#### Scenario: Table without a primary key is not editable

- **WHEN** the user runs `SELECT * FROM event_log` and `event_log` has no primary key
- **THEN** the result carries `{ status: "not_editable", reason: "no_primary_key" }`

#### Scenario: Projection missing a PK column is not editable

- **WHEN** the user runs `SELECT email FROM users` and `users` has PK `(id)`
- **THEN** the result carries `{ status: "not_editable", reason: "pk_not_selected" }`

#### Scenario: Composite PK partially projected is not editable

- **WHEN** the user runs `SELECT tenant_id, name FROM memberships` and the PK is `(tenant_id, user_id)`
- **THEN** the result carries `{ status: "not_editable", reason: "pk_not_selected" }`

#### Scenario: The same base column projected twice is not editable

- **WHEN** the user runs `SELECT id, id AS also_id, email FROM users`
- **THEN** the result carries `{ status: "not_editable", reason: "duplicate_projection" }`

#### Scenario: Two computed columns do not count as duplicates

- **WHEN** the user runs `SELECT id, 1 AS a, 2 AS b FROM users`
- **THEN** the result is `status: "editable"` with `column_sources: ["id", null, null]`

### Requirement: Editability resolution never fails the run

Resolving `ResultEditability` SHALL be strictly best-effort. A failure of the
provenance or catalog lookup — connection error, timeout, permission error on a
catalog relation, or an unexpected catalog shape — MUST NOT fail, delay past the
statement's own timeout, or alter the rows result. On any such failure the engine
MUST emit `{ status: "not_editable", reason: "no_base_table" }` and log the
underlying cause at `warn` level.

The resolver MUST short-circuit before issuing any catalog query when no result
column carries relation provenance, so statements that cannot possibly be editable
(`SELECT 1`, aggregates, `EXPLAIN`, DDL, DML without `RETURNING`) pay no additional
round-trip.

#### Scenario: Catalog lookup failure degrades to not editable

- **WHEN** the provenance lookup for a `SELECT * FROM users` run raises a Postgres error
- **THEN** the run still returns its rows and `query_ms` unchanged
- **AND** the result carries `{ status: "not_editable", reason: "no_base_table" }`
- **AND** a `warn`-level log line records the underlying error

#### Scenario: No provenance means no catalog query

- **WHEN** the user runs `SELECT 1`
- **THEN** no catalog query is issued for editability resolution
- **AND** the result carries `{ status: "not_editable", reason: "no_base_table" }`

#### Scenario: Affected-shaped results carry no editability

- **WHEN** the user runs `UPDATE users SET active = false`
- **THEN** the response is the `kind: "affected"` envelope
- **AND** it carries no `editability` field

### Requirement: Editable cells are addressed by base column and primary key

A consumer that renders an editable ad-hoc result SHALL address every pending edit
by `(primary-key values, base column name)` — never by result-row index and never
by result column name. Row identity MUST be derived from the values at
`pk_column_indexes` in that row's server values, so that client-side reordering,
re-sorting, or filtering of the displayed rows cannot mis-target a write.

A result column whose `column_sources` entry is `null` MUST NOT be editable, since
there is no base column to write to.

#### Scenario: Sorting the result does not mis-target a pending edit

- **WHEN** the user edits the `email` cell of the row with `id = 7`, then sorts the grid by another column so that row moves position
- **THEN** the pending edit is still attached to the row with `id = 7`
- **AND** committing issues `UPDATE ... SET "email" = $1 WHERE "id" = $2` with `$2 = 7`

#### Scenario: Aliased column writes to the base column

- **WHEN** the result came from `SELECT id, email AS mail FROM users` and the user edits the `mail` cell of row `id = 7`
- **THEN** the emitted edit op has `changes: { "email": <new value> }`
- **AND** it does NOT reference `"mail"`

#### Scenario: Computed column is never editable

- **WHEN** the result came from `SELECT id, upper(email) AS shout FROM users`
- **THEN** the `shout` cells are read-only
- **AND** the `id` cell is read-only because it is a primary-key column of an existing row
