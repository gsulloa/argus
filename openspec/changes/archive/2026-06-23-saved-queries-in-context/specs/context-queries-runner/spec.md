## ADDED Requirements

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
