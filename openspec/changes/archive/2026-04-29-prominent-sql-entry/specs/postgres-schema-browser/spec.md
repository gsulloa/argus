## MODIFIED Requirements

### Requirement: New Query button on each active connection row

The sidebar SHALL render a `+ Query` icon button in a **primary actions slot** of every active Postgres connection row, distinct from the secondary toolbar slot that hosts refresh + visibility-picker. The button MUST:

- Be **always visible** (never hidden behind hover) while the connection is connected.
- NOT render when the connection is disconnected.
- Use a tone consistent with other sidebar icons (`var(--text-muted)` default, `var(--text)` on hover) — NOT `var(--accent)`, which is reserved for the active dot and selection highlights.
- Carry the tooltip `New SQL query · ⌘↩ runs` so the user discovers the run shortcut.
- Be keyboard-focusable and activatable via Enter/Space.

Activating the button MUST open a new `postgres-query` tab against that connection (equivalent to `SQL: New Query` for that connection).

The secondary toolbar (refresh + visibility-picker) keeps its existing hover-only visibility — those are maintenance actions and the convention is unchanged.

#### Scenario: Button is permanently visible while the connection is connected

- **WHEN** a Postgres connection is connected and visible in the sidebar
- **THEN** the `+ Query` icon button is rendered in the primary actions slot of that row with full opacity
- **AND** the button is visible without the user hovering the row

#### Scenario: Button is hidden on disconnected connection rows

- **WHEN** a Postgres connection is disconnected
- **THEN** its row does NOT display the `+ Query` button

#### Scenario: Activating the button opens a query tab

- **WHEN** the user clicks the `+ Query` button on connection `local-pg`
- **THEN** a new `postgres-query` tab opens with payload `{ connectionId: <id>, connectionName: "local-pg", sql: "" }`
- **AND** the editor in that tab takes focus

#### Scenario: Tooltip advertises the run shortcut

- **WHEN** the user hovers the `+ Query` button
- **THEN** a tooltip reads `New SQL query · ⌘↩ runs`

#### Scenario: Refresh and visibility picker remain hover-only

- **WHEN** the user has not hovered the connection row
- **THEN** the refresh icon and visibility-picker icon are NOT visible
- **AND** when the user hovers the row, both icons fade in

## ADDED Requirements

### Requirement: New SQL Query item in connection-row context menu

The right-click context menu on a Postgres connection row SHALL include a `New SQL Query` item at the top of the menu when the connection is connected. The item MUST:

- Sit above the existing `Edit / Duplicate / Delete` items.
- Be separated from the modification items by a visual separator.
- Open a new `postgres-query` tab against that connection when activated (same handler as the `+ Query` button).
- NOT appear when the connection is disconnected.

#### Scenario: New SQL Query appears for connected connections

- **WHEN** the user right-clicks a connected Postgres connection row
- **THEN** the context menu shows `New SQL Query` as its first item, followed by a separator, then `Edit`, `Duplicate`, `Delete`

#### Scenario: New SQL Query is hidden for disconnected connections

- **WHEN** the user right-clicks a disconnected Postgres connection row
- **THEN** the context menu shows `Edit`, `Duplicate`, `Delete` only — no `New SQL Query` item, no leading separator

#### Scenario: Activating the menu item opens a query tab

- **WHEN** the user right-clicks a connected connection row and selects `New SQL Query`
- **THEN** a new `postgres-query` tab opens against that connection with an empty SQL buffer
- **AND** the editor in that tab takes focus
