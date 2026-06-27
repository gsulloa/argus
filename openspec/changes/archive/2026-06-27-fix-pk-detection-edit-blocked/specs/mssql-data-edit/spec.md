## MODIFIED Requirements

### Requirement: Tables without a PK

When the loaded relation's `columns` (from `mssql_table_primary_key`) is `null` **and the lookup resolved successfully**, the viewer SHALL keep `INSERT` enabled but SHALL disable `UPDATE` and `DELETE` affordances. The viewer MUST display a banner in the bottom bar stating that the relation has no primary key and that existing rows cannot be edited or deleted via Argus. Double-clicking an existing-row cell on such a relation MUST be a no-op.

A failed `mssql_table_primary_key` lookup MUST NOT be coerced to `null` (= "no PK"). When the lookup rejects with an error, the viewer SHALL NOT show the "no primary key" banner; it MUST instead show a distinct error banner that names the underlying cause and offers a **Retry** action that re-invokes the lookup. While in the error state, `UPDATE`/`DELETE` affordances stay disabled (the PK is genuinely unknown), but the banner MUST NOT claim the relation lacks a primary key.

#### Scenario: View has no PK so update/delete are off

- **WHEN** the user opens a view (`columns: null`, lookup succeeded)
- **THEN** the bottom bar shows a `no primary key` banner
- **AND** double-clicking a cell is a no-op
- **AND** the `Add row` button is hidden (because the relation is a view)

#### Scenario: Heap table without explicit PK still allows insert

- **WHEN** the user opens a heap table (no clustered index, no PRIMARY KEY) on a writable connection
- **THEN** the `Add row` button is rendered (insert is allowed)
- **AND** existing rows are read-only with the `no PK` banner visible

#### Scenario: Failed PK lookup shows a retryable error, not "no primary key"

- **WHEN** the user opens a table whose `mssql_table_primary_key` lookup rejects with an error
- **THEN** the bottom bar shows an error banner naming the underlying cause
- **AND** the banner offers a Retry action that re-invokes the lookup
- **AND** the `no primary key` banner is NOT shown

#### Scenario: Retry after a failed lookup restores editing

- **WHEN** a PK lookup failed and the user clicks Retry, and the retry succeeds with PK columns `["id"]`
- **THEN** the error banner is dismissed
- **AND** existing rows become editable/deletable
