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

### Requirement: Aggregate listing of context queries across linked folders

The platform SHALL expose `context_list_linked_queries()` returning context queries grouped per distinct **canonical context root + engine**. Each group SHALL include the canonical root path, a human-readable project name (from the folder's `context.yaml` `name`, falling back to the folder basename), the engine, a representative connection id (a live connection linked to that root, preferred over a disconnected one), and the list of `QueryListItem`s for that engine. Connections sharing a canonical root MUST be collapsed into a single group per engine (no duplicates).

#### Scenario: Two connections sharing a root produce one group per engine

- **WHEN** connections A and B are both Postgres and linked to the same canonical context root containing `postgres/queries/top-customers.sql`
- **THEN** `context_list_linked_queries()` returns a single Postgres group for that root containing `top-customers`

#### Scenario: Group carries a representative connection id for running

- **WHEN** a context root has a connected and a disconnected connection linked to it
- **THEN** the returned group's representative connection id refers to the connected connection

#### Scenario: No linked folders yields an empty result

- **WHEN** no connection has a `context_path`
- **THEN** `context_list_linked_queries()` returns an empty list

### Requirement: Context queries are runnable from the unified Saved Queries panel

Context queries surfaced in the Saved Queries panel SHALL be openable and runnable with the same behavior as the per-connection Context Queries branch (`context-queries-runner`): opening a context query loads its body into an editor tab against the group's representative connection, applying per-engine named-parameter substitution as already specified. Parameter prompting and substitution MUST be identical whether the query is opened from the panel or from the per-connection branch.

#### Scenario: Opening a context query from the panel uses the representative connection

- **WHEN** the user opens context query `top-customers` from the Saved Queries panel
- **THEN** the query body opens in an editor tab bound to the group's representative connection

#### Scenario: Parameterized context query prompts identically from the panel

- **WHEN** a context query declares params and the user runs it from the panel
- **THEN** the same parameter-substitution flow applies as when run from the per-connection Context Queries branch

