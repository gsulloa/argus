# connection-colors Specification

## Purpose
TBD - created by archiving change connection-colors. Update Purpose after archive.
## Requirements
### Requirement: Connection color palette

The platform SHALL define a fixed, curated palette of connection colors. Each color is identified by a stable lowercase key. The supported keys SHALL be exactly: `violet`, `blue`, `green`, `amber`, `red`, `teal`, `pink`, `gray`. A connection MAY also have no color, represented as the absence of a key (`null`). The palette MUST NOT be user-extensible and free-form / custom hex values MUST NOT be accepted. Each key SHALL map to theme-appropriate rendered shades for both the dark and light themes, sourced from `DESIGN.md` color tokens, so the same stored key renders legibly under either theme.

#### Scenario: Palette exposes a fixed set of keys

- **WHEN** the connection color palette is presented to the user (e.g. in the form picker)
- **THEN** exactly the keys `violet`, `blue`, `green`, `amber`, `red`, `teal`, `pink`, `gray` are offered, plus a "no color" option

#### Scenario: Color renders per theme

- **WHEN** a connection has color `amber` and the app is in light theme
- **THEN** the amber indicator uses the light-theme amber shade (not the dark-theme shade), preserving contrast against the light canvas

### Requirement: Assigning and clearing a connection color

A user SHALL be able to assign any palette color to a connection and SHALL be able to clear it back to "no color". The assignment is persisted on the connection record via the connection-registry create/update commands. An attempt to set a color key that is not in the fixed palette MUST be rejected as a validation error and MUST NOT be persisted.

#### Scenario: Assign a color

- **WHEN** the user picks the `green` swatch for a connection and saves
- **THEN** the connection's stored color is `green`

#### Scenario: Clear a color

- **WHEN** a connection has color `green` and the user picks the "no color" option and saves
- **THEN** the connection's stored color is `null`

#### Scenario: Unknown color key is rejected

- **WHEN** a caller attempts to persist a connection with color `"chartreuse"` (not in the palette)
- **THEN** the operation returns a validation error and the connection's stored color is unchanged

### Requirement: Color is rendered in the connection rail

When a connection in the connection rail has an explicit color, the rail's environment indicator dot SHALL render that color. When the connection has no explicit color, the rail SHALL fall back to the existing name-based environment heuristic. The color indicator MUST be a small dot consistent with `DESIGN.md` restraint (no full-item background fills).

#### Scenario: Colored connection shows its color in the rail

- **WHEN** an open connection has color `red`
- **THEN** its rail item's indicator dot is rendered in the red palette shade

#### Scenario: Uncolored connection falls back to the heuristic

- **WHEN** an open connection has no color and its name contains "prod"
- **THEN** its rail item's indicator dot uses the production (amber) heuristic color, as before

### Requirement: Color is rendered in the sidebar connection row

When a connection has an explicit color, its sidebar row (`ConnectionRow`, in both manager and workspace modes) SHALL display a small color swatch adjacent to the engine icon. When the connection has no color, no swatch is shown and the row renders as it does today. The swatch MUST NOT replace or obscure the engine icon, the active/connected dot, or the focused-row stripe.

#### Scenario: Colored connection shows a swatch in the sidebar

- **WHEN** a connection with color `blue` is listed in the sidebar
- **THEN** a small blue swatch appears adjacent to its engine icon

#### Scenario: Uncolored connection shows no swatch

- **WHEN** a connection with no color is listed in the sidebar
- **THEN** no color swatch is rendered and the row layout is unchanged from current behavior
