# context-queries-runner Specification

## Purpose
TBD - created by archiving change context-folders-other-engines. Update Purpose after archive.
## Requirements
### Requirement: Context queries sidebar branch

For each connection with a linked context folder containing matching `queries/` files, the sidebar SHALL render a "Context Queries" branch under the connection node, distinct from and rendered separately from the top-level "Saved Queries" branch. The branch lists the parsed queries by `name`, sorted alphabetically. The branch SHALL update in response to `context://changed` events whose `kinds` include `"query"` for the connection's folder path.

#### Scenario: Branch renders when queries exist

- **WHEN** a Postgres connection is linked to a folder with `postgres/queries/top-customers.sql` and `postgres/queries/stuck-orders.sql`
- **THEN** the sidebar shows a "Context Queries" branch under that connection containing `stuck-orders` and `top-customers` in that order

#### Scenario: Branch hidden when no queries

- **WHEN** a linked folder has no `queries/` files for the connection's engine
- **THEN** no "Context Queries" branch renders under that connection

#### Scenario: Branch is distinct from Saved Queries

- **WHEN** both "Context Queries" (linked folder) and "Saved Queries" (sqlite) contain a query named `top-customers`
- **THEN** the sidebar shows them in two separate branches and the user can open both

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

### Requirement: Open context query in editor tab

Activating a context-query entry SHALL open a SQL-editor tab (engine-appropriate) pre-populated with the query body. If the query's meta declares one or more `params`, the tab SHALL render a parameter strip above the editor with one input per param, pre-filled with each param's `default` value (or empty if no default). The tab title SHALL be the query's `name`. Editing the body in the tab SHALL NOT modify the file on disk.

#### Scenario: Tab opens with body and title

- **WHEN** the user activates `top-customers` whose meta `name` is "Top customers since date"
- **THEN** a new editor tab opens titled "Top customers since date" with the SQL body in the editor

#### Scenario: Param strip rendered with defaults

- **WHEN** the query's meta declares `params: [{ name: since, type: timestamp, default: "2026-01-01" }, { name: limit, type: int, default: 50 }]`
- **THEN** the tab renders two inputs labelled `since` and `limit` pre-filled with `2026-01-01` and `50`

#### Scenario: No params means no strip

- **WHEN** the query's meta has `params: []` or no meta file
- **THEN** the tab renders no parameter strip

#### Scenario: Edits in the tab do not write to disk

- **WHEN** the user edits the body in the editor tab and runs it
- **THEN** the file on disk is unchanged

### Requirement: Run with named parameter substitution

Running a context query SHALL substitute the user-supplied parameter values into the body using the engine's native named-binding form (`:name` for Postgres and MySQL, `@name` for MSSQL, `$name` for DynamoDB PartiQL), invoke the connection's existing SQL execution path with those bindings, and surface results in the same result panel used by the SQL editor today.

#### Scenario: Postgres uses colon-prefixed names

- **WHEN** a Postgres context query body is `SELECT * FROM users WHERE created_at >= :since LIMIT :limit;` and the user runs it with `since=2026-01-01, limit=50`
- **THEN** the existing Postgres execution path is invoked with the body unchanged and bindings `{ since: "2026-01-01", limit: 50 }`

#### Scenario: MSSQL uses @-prefixed names

- **WHEN** a MSSQL context query body is `SELECT * FROM users WHERE created_at >= @since;` and the user runs it with `since=2026-01-01`
- **THEN** the existing MSSQL execution path is invoked with the body unchanged and binding `{ "@since": "2026-01-01" }`

#### Scenario: DynamoDB uses dollar-prefixed names

- **WHEN** a Dynamo PartiQL context query body is `SELECT * FROM sessions WHERE user_id = $uid` and the user runs it with `uid=u_123`
- **THEN** the existing Dynamo PartiQL execution path is invoked with the body unchanged and binding `{ "$uid": "u_123" }`

#### Scenario: Missing param value blocks run

- **WHEN** a query declares a required `params` entry with no default and the user leaves the input empty
- **THEN** the Run action is disabled and a hint indicates which parameters are required

