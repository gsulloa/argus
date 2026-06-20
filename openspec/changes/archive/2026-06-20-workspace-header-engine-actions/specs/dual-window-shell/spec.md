## ADDED Requirements

### Requirement: Workspace identity header exposes per-engine contextual actions

The Workspace sidebar identity header SHALL render the focused connection's per-engine contextual actions inline in a dedicated, right-aligned actions slot, dispatched by the connection's engine kind. The actions presented MUST match the engine's capabilities and reuse the same action components as the rest of the app (single source of truth — no engine-specific action is reimplemented for the header):

- **PostgreSQL** — New SQL query, Refresh schemas, and a visible-schemas picker.
- **MySQL** — New SQL query, Refresh databases, and a visible-schemas picker.
- **MSSQL** — New SQL query, Refresh, and a visible-schemas picker.
- **Athena** — New SQL query and Refresh.
- **DynamoDB** — Refresh tables.

Engine kinds with no defined header actions (e.g. `cloudwatch`) SHALL render no actions slot content and MUST NOT error. The header MUST update reactively when the focused connection changes, showing the newly-focused connection's actions. Triggering a header action MUST have the same effect as triggering the corresponding action elsewhere in the app (e.g. "New SQL query" opens a new query tab bound to the focused connection).

#### Scenario: Postgres connection shows query, refresh, and schema picker

- **WHEN** a PostgreSQL connection is focused in the Workspace
- **THEN** the identity header shows a New SQL query action, a Refresh action, and a visible-schemas picker
- **AND** clicking New SQL query opens a new query tab bound to that connection

#### Scenario: DynamoDB connection shows only refresh

- **WHEN** a DynamoDB connection is focused in the Workspace
- **THEN** the identity header shows a Refresh tables action
- **AND** it shows no SQL-query or visible-schemas actions

#### Scenario: Athena connection shows query and refresh, no schema picker

- **WHEN** an Athena connection is focused in the Workspace
- **THEN** the identity header shows a New SQL query action and a Refresh action
- **AND** it shows no visible-schemas picker

#### Scenario: Engine without header actions renders cleanly

- **WHEN** a connection whose engine kind has no defined header actions (e.g. `cloudwatch`) is focused in the Workspace
- **THEN** the identity header renders the connection identity with no action controls and without error

#### Scenario: Actions follow focus changes

- **WHEN** the focused connection changes from one engine to another (e.g. Postgres to DynamoDB)
- **THEN** the identity header replaces the previous engine's actions with the newly-focused connection's actions
