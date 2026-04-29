## MODIFIED Requirements

### Requirement: Palette commands for schema browsing

The Postgres module SHALL register the following commands in the `command-palette` registry on app start: `Schema: Refresh` (drops the schema cache for the focused connection and re-fetches schemas), `Schema: Filter Visible…` (opens the visible-schemas picker for the focused connection), `SQL: New Query` (opens a new `postgres-query` tab against the focused connection), and `SQL: New Query Here` (opens a new `postgres-query` tab pre-populated with SQL contextual to the focused sidebar node). When no connection is focused, all four commands MUST transition the palette to a connection chooser.

`SQL: New Query` MUST always open with an empty SQL buffer. `SQL: New Query Here` MUST pre-populate the buffer based on the focused node:

- Connection focused → empty buffer (equivalent to `SQL: New Query`).
- Schema focused → `SET search_path TO "<schema>";\n\n`.
- Table, view, or materialized view focused → `SELECT * FROM "<schema>"."<relation>" LIMIT 100;`.
- Any other node kind (function, type, extension, index, trigger) → empty buffer with the connection set to the focused node's connection.

#### Scenario: Refresh on focused connection clears its cache

- **WHEN** the user has a connection focused and runs `Schema: Refresh`
- **THEN** the cache for that connection is dropped, `postgres.listSchemas` is re-invoked, and the tree re-renders with the new result

#### Scenario: Filter Visible opens the picker

- **WHEN** the user has a connection focused and runs `Schema: Filter Visible…`
- **THEN** the visible-schemas picker for that connection opens

#### Scenario: Commands without a focused connection show a chooser

- **WHEN** the user runs `Schema: Refresh` with no sidebar connection focused
- **THEN** the palette transitions to a chooser listing connected Postgres connections; selecting one runs the refresh

#### Scenario: New Query opens a fresh empty query tab

- **WHEN** the user has a connection focused and runs `SQL: New Query`
- **THEN** a new `postgres-query` tab opens against that connection with an empty SQL buffer

#### Scenario: New Query Here on a table pre-populates a SELECT

- **WHEN** the user has the table `analytics.events` focused in the sidebar and runs `SQL: New Query Here`
- **THEN** a new `postgres-query` tab opens with SQL `SELECT * FROM "analytics"."events" LIMIT 100;`
- **AND** the cursor lands at the end of the document so the user can immediately edit or run

#### Scenario: New Query Here on a schema sets search_path

- **WHEN** the user has the schema `analytics` focused and runs `SQL: New Query Here`
- **THEN** a new `postgres-query` tab opens with SQL `SET search_path TO "analytics";` followed by two newlines

#### Scenario: New Query without a focused connection prompts a chooser

- **WHEN** the user runs `SQL: New Query` with no sidebar focus
- **THEN** the palette transitions to a chooser listing connected Postgres connections; selecting one opens the query tab against it

## ADDED Requirements

### Requirement: New Query button on each active connection row

The schema tree SHALL render a `+ Query` icon button in the actions area of every active Postgres connection row in the sidebar (alongside the existing refresh button). Activating the button MUST open a new `postgres-query` tab against that connection (equivalent to `SQL: New Query` for that connection). The button MUST be visible whenever the connection is connected; it MUST be hidden when the connection is disconnected. The button MUST be keyboard-focusable and activatable via Enter/Space.

#### Scenario: Button appears on active connection rows

- **WHEN** a Postgres connection is connected and visible in the sidebar
- **THEN** its row displays a `+ Query` icon button in the actions area

#### Scenario: Activating the button opens a query tab

- **WHEN** the user clicks the `+ Query` button on connection `local-pg`
- **THEN** a new `postgres-query` tab opens with payload `{ connectionId: <id>, connectionName: "local-pg", sql: "" }`
- **AND** the editor in that tab takes focus

#### Scenario: Button is hidden on disconnected connection rows

- **WHEN** a Postgres connection is disconnected
- **THEN** its row does NOT display the `+ Query` button
