# connection-rail Specification

## Purpose
TBD - created by archiving change add-dual-window-shell. Update Purpose after archive.
## Requirements
### Requirement: The rail lists only open connections

The Workspace SHALL present a vertical **connection rail** as its level-1 navigation, listing exactly the connections that are currently open (per the `connections:open-changed` source of truth). Saved-but-not-open connections MUST NOT appear in the rail; they live only in the Manager. When a connection is opened it MUST appear in the rail; when it is closed it MUST disappear from the rail.

#### Scenario: Open connections populate the rail

- **WHEN** two connections are open
- **THEN** the rail shows exactly two items, one per open connection

#### Scenario: Closed connection leaves the rail

- **WHEN** a connection shown in the rail is closed (from either window)
- **THEN** that item disappears from the rail

#### Scenario: Saved connections are not shown in the rail

- **WHEN** the user has ten saved connections but only one is open
- **THEN** the rail shows exactly one item

### Requirement: Rail item appearance

Each rail item SHALL display the connection's engine icon, an environment-color indicator, and the connection **name in small text beneath the icon** (truncated with an ellipsis when it does not fit; the full name remains available on hover). The visual treatment MUST follow `DESIGN.md` (engine icons, small `--text-xs`-scale label, no decorative gradients, restrained color). The currently focused item MUST be visually distinguished from the others.

#### Scenario: Engine icon, environment color, and small name label

- **WHEN** the rail renders an open Postgres connection marked as a production environment
- **THEN** the item shows the Postgres engine icon, the production environment color, and the connection name in a small label beneath the icon

#### Scenario: Long name is truncated

- **WHEN** a rail item's connection name is too long to fit the rail width
- **THEN** the small name label is truncated with an ellipsis
- **AND** the full name is available on hover (tooltip)

#### Scenario: Focused item is distinguished

- **WHEN** one rail item is the focused connection
- **THEN** it is rendered in the focused/selected state, visually distinct from the other items

### Requirement: Focus selection drives the Workspace

Selecting a rail item SHALL make that connection the **focused connection**. Exactly one connection is focused at a time. The focused connection MUST drive (1) the level-2 schema tree, which shows only the focused connection's objects; (2) the visible tab set, which is the focused connection's tabs; and (3) the default scope of the table quick-switcher (⌘P).

#### Scenario: Selecting a rail item focuses its connection

- **WHEN** the user clicks a rail item that is not currently focused
- **THEN** that connection becomes the focused connection

#### Scenario: Only the focused connection's tree is shown

- **WHEN** connections A and B are both open and A is focused
- **THEN** the level-2 schema tree shows only A's objects and not B's

#### Scenario: Switching focus swaps the tab set

- **WHEN** A is focused with its own open tabs and the user selects B in the rail
- **THEN** the visible tab strip becomes B's tab set
- **AND** switching back to A restores A's tabs and active tab (its content was not unmounted)

### Requirement: Focused connection identity is legible

The Workspace SHALL make the focused connection's identity legible **without requiring hover**: its name MUST be displayed in a persistent location (for example a header above the level-2 schema tree), together with its engine and environment indicator. When the focused connection belongs to a connection group, the name MUST be displayed as `<group name> - <connection name>`; when it has no group, only the connection name is shown. Relying solely on the engine icon (which only conveys *type*, e.g. Postgres vs Dynamo, not *which* connection) is insufficient. The identity display MUST update when the focused connection changes.

#### Scenario: Grouped connection shows "group - connection"

- **WHEN** the focused connection belongs to a group named "Prod" and is named "orders-db"
- **THEN** the persistent identity display reads "Prod - orders-db"
- **AND** its engine and environment are indicated alongside

#### Scenario: Ungrouped connection shows just the name

- **WHEN** the focused connection has no group and is named "scratch"
- **THEN** the persistent identity display reads "scratch" (no leading separator)

#### Scenario: Identity updates on focus change

- **WHEN** the user selects a different connection in the rail
- **THEN** the persistent identity display updates to the newly focused connection's name

### Requirement: Closing a connection from the rail

The rail SHALL let the user close (disconnect) a connection directly from a rail item (for example via a context menu). Closing a connection MUST disconnect it and remove it from the rail. If the closed connection was the focused one and other connections remain open, focus MUST move to a neighboring rail item.

#### Scenario: Close from the rail context menu

- **WHEN** the user invokes "Close connection" on a rail item
- **THEN** that connection is disconnected and removed from the rail

#### Scenario: Focus moves to a neighbor

- **WHEN** the focused connection is closed and at least one other connection remains open
- **THEN** a neighboring rail item becomes the focused connection

### Requirement: Empty rail closes the Workspace

When the last open connection is closed and the rail becomes empty, the Workspace window SHALL close and the Manager window SHALL be shown and focused.

#### Scenario: Closing the last connection returns to the Manager

- **WHEN** exactly one connection is open and the user closes it
- **THEN** the rail becomes empty, the Workspace window closes, and the Manager is shown and focused

### Requirement: Rail "+" reopens the Manager

The rail SHALL provide a "+" affordance at its end that opens the Connection Manager. If the Manager window was closed, the affordance MUST recreate it; if it exists, the affordance MUST focus it.

#### Scenario: Plus recreates a closed Manager

- **WHEN** the Manager window was closed and the user clicks the rail "+"
- **THEN** the Manager window is created and focused

#### Scenario: Plus focuses an existing Manager

- **WHEN** the Manager window already exists and the user clicks the rail "+"
- **THEN** the existing Manager window is focused (no second Manager is created)

