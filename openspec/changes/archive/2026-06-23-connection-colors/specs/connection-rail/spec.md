## MODIFIED Requirements

### Requirement: Rail item appearance

Each rail item SHALL display the connection's engine icon, a color indicator, and the connection **name in small text beneath the icon** (truncated with an ellipsis when it does not fit; the full name remains available on hover). The color indicator SHALL render the connection's explicit color when one is assigned; when the connection has no explicit color, the indicator SHALL fall back to the name-based environment heuristic (production names → warning color, otherwise neutral). The visual treatment MUST follow `DESIGN.md` (engine icons, small `--text-xs`-scale label, no decorative gradients, restrained color — the indicator is a small dot, never a full-item fill). The currently focused item MUST be visually distinguished from the others.

#### Scenario: Engine icon, explicit color, and small name label

- **WHEN** the rail renders an open Postgres connection with the explicit color `red`
- **THEN** the item shows the Postgres engine icon, a red indicator dot, and the connection name in a small label beneath the icon

#### Scenario: Uncolored connection falls back to the environment heuristic

- **WHEN** the rail renders an open connection that has no explicit color and whose name marks it as a production environment
- **THEN** the item's indicator dot uses the production environment (warning) color

#### Scenario: Long name is truncated

- **WHEN** a rail item's connection name is too long to fit the rail width
- **THEN** the small name label is truncated with an ellipsis
- **AND** the full name is available on hover (tooltip)

#### Scenario: Focused item is distinguished

- **WHEN** one rail item is the focused connection
- **THEN** it is rendered in the focused/selected state, visually distinct from the other items
