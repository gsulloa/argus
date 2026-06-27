## MODIFIED Requirements

### Requirement: Primary key lookup command

The Postgres module SHALL expose a Tauri command `postgres_table_primary_key(connection_id, schema, relation, origin?)` that returns `{ pk_columns: string[] | null, enums: { [column: string]: string[] } }`. `pk_columns` MUST list the PK columns in their declared order, or be `null` when the relation has no primary key. `enums` MUST map each column whose `pg_type.typcategory = 'E'` to the array of allowed enum labels in declared order. The command SHALL acquire a connection from the pool registry, MUST honor the same read-only-aware `executeQuery` path used by `postgres_query_table`, and MUST emit one `argus:activity-log` event before returning with `kind: "list_table_extras"` (reusing the existing kind for catalog metadata) and `metric: { kind: "items", value: <pk_columns_count + enum_columns_count, treating null as 0> }`.

The PK lookup and the enum lookup are independent: a failure of the enum sub-query MUST NOT discard a successfully-fetched PK. When the enum lookup fails but the PK lookup succeeds, the command SHALL return the resolved `pk_columns` with `enums: {}` rather than returning an error. The command SHALL only return an error when the PK lookup itself fails (e.g. connection error, timeout) — never to signal a relation that genuinely has no primary key (that case returns `pk_columns: null`).

#### Scenario: Table with simple PK

- **WHEN** the frontend invokes `postgres_table_primary_key(id, "public", "users")`
- **THEN** the response contains `{ pk_columns: ["id"], enums: {} }`

#### Scenario: Table with composite PK

- **WHEN** the frontend invokes the command for a table with PK `(tenant_id, user_id)` declared in that order
- **THEN** the response is `{ pk_columns: ["tenant_id", "user_id"], enums: {} }`

#### Scenario: View has no PK

- **WHEN** the frontend invokes the command against a view (`pg_class.relkind = 'v'`)
- **THEN** the response is `{ pk_columns: null, enums: {} }`

#### Scenario: Enum columns are surfaced

- **WHEN** the table has a column `status` of enum type with values `("active", "archived", "deleted")`
- **THEN** the response includes `enums: { status: ["active", "archived", "deleted"] }`

#### Scenario: Enum lookup failure does not discard a valid PK

- **WHEN** the PK lookup succeeds with `["id"]` but the enum sub-query fails
- **THEN** the command returns `{ pk_columns: ["id"], enums: {} }` (no error)
- **AND** edit affordances remain available because the PK is known

#### Scenario: PK lookup failure returns an error, not null

- **WHEN** the PK lookup itself fails (e.g. the query times out)
- **THEN** the command returns an `AppError` describing the failure
- **AND** does NOT return `{ pk_columns: null }`

### Requirement: Tables without a PK

When the loaded relation's `pk_columns` is `null` **and the PK lookup resolved successfully**, the viewer SHALL keep `INSERT` enabled but SHALL disable `UPDATE` and `DELETE` affordances. The viewer MUST display a banner in the bottom bar stating that the relation has no primary key and that existing rows cannot be edited or deleted via Argus. Double-clicking an existing-row cell on such a relation MUST be a no-op.

A failed PK-metadata lookup MUST NOT be treated as "no primary key". When the `postgres_table_primary_key` lookup errors, the viewer SHALL NOT show the "no primary key" banner; it MUST instead show a distinct error banner that names the underlying cause and offers a **Retry** action that re-invokes the lookup. While the lookup is in the error state, `UPDATE`/`DELETE` affordances stay disabled (the PK is genuinely unknown), but the banner MUST NOT claim the relation lacks a primary key.

#### Scenario: View has no PK so insert/update/delete are off

- **WHEN** the user opens a view (`pk_columns: null`, lookup succeeded)
- **THEN** the bottom bar shows a banner explaining the relation has no PK
- **AND** double-clicking a cell is a no-op (no inline editor)
- **AND** the "Add row" button is hidden

#### Scenario: Table without explicit PK still allows insert

- **WHEN** the user opens a table that has columns but no `PRIMARY KEY` constraint, on a writable connection
- **THEN** the "Add row" button is rendered (insert is allowed)
- **AND** existing rows are read-only with the "no PK" banner visible

#### Scenario: Failed PK lookup shows a retryable error, not "no primary key"

- **WHEN** the user opens a table whose `postgres_table_primary_key` lookup rejects with an error
- **THEN** the bottom bar shows an error banner naming the underlying cause
- **AND** the banner offers a Retry action that re-invokes the lookup
- **AND** the "No primary key — existing rows are not editable" banner is NOT shown

#### Scenario: Retry after a failed lookup restores editing

- **WHEN** a PK lookup failed and the user clicks Retry, and the retry succeeds with `pk_columns: ["id"]`
- **THEN** the error banner is dismissed
- **AND** existing rows become editable/deletable
