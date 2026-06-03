## ADDED Requirements

### Requirement: Context queries sidebar branch

For each connection with a linked context folder containing matching `queries/` files, the sidebar SHALL render a "Context Queries" branch under the connection node. This applies to connections of kind `postgres`, `mysql`, `mssql`, and `dynamo`. The branch is distinct from and rendered separately from the top-level "Saved Queries" branch. The branch lists the parsed queries by `name`, sorted alphabetically, and updates in response to `context://changed` events whose `kinds` include `"query"`.

#### Scenario: MySQL connection shows Context Queries branch

- **WHEN** a MySQL connection is linked to a folder with `mysql/queries/active-sessions.sql`
- **THEN** the sidebar shows a "Context Queries" branch under that connection containing `active-sessions`

#### Scenario: MSSQL connection shows Context Queries branch

- **WHEN** an MSSQL connection is linked to a folder with `mssql/queries/recent-errors.sql`
- **THEN** the sidebar shows a "Context Queries" branch containing `recent-errors`

#### Scenario: Dynamo connection shows Context Queries branch

- **WHEN** a Dynamo connection is linked to a folder with `dynamo/queries/active-users.partiql`
- **THEN** the sidebar shows a "Context Queries" branch containing `active-users`

### Requirement: Per-engine parameter substitution

Activating a context query SHALL open an editor tab pre-populated with the body, and "Insert into editor" SHALL substitute the user-supplied parameter values using the engine's placeholder convention:

- Postgres and MySQL: `:name` placeholders, with strings single-quote-escaped (`'` doubled), numbers and booleans inserted raw.
- MSSQL: `@name` placeholders, with the same value-escaping rules.
- Dynamo PartiQL: `$name` placeholders, with strings wrapped in `'…'` (`''` doubling), numbers raw, booleans raw, `null` as `NULL`. (Native PartiQL positional binding is not used in v1; substitution is textual.)

The substituted body replaces the editor's current value via the existing editor handle. The user runs the substituted query via the engine's existing Run button. No auto-binding pipeline is added in this change.

#### Scenario: MySQL substitutes :name placeholders

- **WHEN** a MySQL context query body is `SELECT * FROM users WHERE created_at >= :since LIMIT :limit;` with `since=2026-01-01, limit=50`
- **AND** the user clicks "Insert into editor"
- **THEN** the editor value becomes `SELECT * FROM users WHERE created_at >= '2026-01-01' LIMIT 50;`

#### Scenario: MSSQL substitutes @name placeholders

- **WHEN** an MSSQL context query body is `SELECT TOP (@limit) * FROM Users WHERE LastLogin >= @since;` with `since=2026-01-01, limit=50`
- **AND** the user clicks "Insert into editor"
- **THEN** the editor value becomes `SELECT TOP (50) * FROM Users WHERE LastLogin >= '2026-01-01';`

#### Scenario: Dynamo substitutes $name placeholders

- **WHEN** a Dynamo PartiQL context query body is `SELECT * FROM sessions WHERE user_id = $uid;` with `uid=u_123`
- **AND** the user clicks "Insert into editor"
- **THEN** the editor value becomes `SELECT * FROM sessions WHERE user_id = 'u_123';`

#### Scenario: String values are single-quote-escaped

- **WHEN** a context query is run with a string param containing a single quote (`O'Brien`)
- **AND** the user clicks "Insert into editor"
- **THEN** the substituted body contains the escaped literal `'O''Brien'`
