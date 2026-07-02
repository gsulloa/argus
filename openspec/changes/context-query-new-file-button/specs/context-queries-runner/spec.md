## ADDED Requirements

### Requirement: Context Queries branch offers query creation wherever it renders

Wherever the Context Queries branch renders under a connection (both the Manager window connection list and the Workspace window subtree), it SHALL offer a "New query" action alongside the "New folder" action, for every engine that renders the branch (Postgres, MySQL, MSSQL, Dynamo). Activating "New query" SHALL create an empty query file under the chosen folder (root when none) via `context_save_query` and then open it in an editor tab. The "New query" affordance SHALL be visually distinguished from "New folder" by a file icon (as "New folder" uses a folder icon).

#### Scenario: New query button appears in the Workspace subtree

- **WHEN** a Postgres connection with a linked context folder is shown in the Workspace window
- **THEN** the Context Queries branch header shows both a "New query" action and a "New folder" action

#### Scenario: Creating a query opens an editor tab

- **WHEN** the user activates "New query" in the Context Queries branch and confirms the name `daily-report`
- **THEN** an empty query is created at the target folder via `context_save_query`
- **AND** the newly created query opens in an editor tab

#### Scenario: New query action uses a file icon

- **WHEN** the Context Queries branch renders its "New query" and "New folder" affordances
- **THEN** the "New query" affordance uses a file icon and the "New folder" affordance uses a folder icon, so the two are visually distinct
