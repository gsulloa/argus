## ADDED Requirements

### Requirement: Sidebar connection kind picker

The sidebar's "+" affordance in the "Connections" section SHALL open a small menu whose first item, "New connection", opens a **kind picker** rather than going directly to a kind-specific form. The kind picker MUST render one selectable card per supported connection kind, currently `postgres` and `dynamodb`, each card showing the kind's icon, its display name ("PostgreSQL" / "DynamoDB"), and a one-line description. Activating a card MUST open that kind's connection form (the Postgres form for `postgres`, the Dynamo form for `dynamodb`). The picker MUST be dismissable with `Escape` and via a Cancel affordance, in which case no form is opened.

Connection rows in the "Connections" section SHALL dispatch their icon and primary click handler by the row's `kind` value: `postgres` rows render the Postgres icon and use the Postgres connect/disconnect path; `dynamodb` rows render the Dynamo icon and use the Dynamo connect/disconnect path; rows with an unknown `kind` SHALL fall back to rendering the kind value as plain text (existing behavior) and SHALL have no primary-click handler.

#### Scenario: Plus button opens kind picker

- **WHEN** the user clicks the "+" button in the Connections section header and activates "New connection"
- **THEN** a kind picker dialog opens with at least one card per supported kind (`postgres`, `dynamodb`)

#### Scenario: Picking Postgres opens the Postgres form

- **WHEN** the kind picker is open and the user activates the PostgreSQL card
- **THEN** the Postgres connection form opens in "Form" view with empty fields
- **AND** the kind picker closes

#### Scenario: Picking DynamoDB opens the Dynamo form

- **WHEN** the kind picker is open and the user activates the DynamoDB card
- **THEN** the Dynamo connection form opens with empty fields
- **AND** the kind picker closes

#### Scenario: Escape cancels the kind picker

- **WHEN** the kind picker is open and the user presses Escape (or clicks Cancel)
- **THEN** the picker closes and no form opens

#### Scenario: Postgres row dispatches to Postgres handlers

- **WHEN** the sidebar renders a connection row with `kind: "postgres"`
- **THEN** the row renders the Postgres icon and clicking the inactive row invokes `postgres.connect(id)`

#### Scenario: Dynamo row dispatches to Dynamo handlers

- **WHEN** the sidebar renders a connection row with `kind: "dynamodb"`
- **THEN** the row renders the Dynamo icon and clicking the inactive row invokes `dynamo.connect(id)`

#### Scenario: Unknown kind falls back to plain text

- **WHEN** the sidebar renders a connection row whose `kind` is neither `postgres` nor `dynamodb`
- **THEN** the row renders the `kind` value as plain text in the icon slot and clicking the row has no effect
