## ADDED Requirements

### Requirement: Color is rendered on the active view header

When the focused connection has an explicit color, the workspace connection identity header (`ConnectionIdentityHeader`, shared by the SQL editor, data/table viewer, and schema/object views) SHALL reflect that color as a restrained accent — a stripe, border, and/or soft tint — reusing the `--conn-color-*` palette and theme-appropriate shades. The header accent MUST NOT replace the header background with a saturated fill and MUST preserve the legibility of the connection name, engine label, and header actions. When the focused connection has no explicit color, the header SHALL render exactly as it does today, with no accent and no layout change. The accent SHALL update immediately when the focused connection changes, with no reload.

#### Scenario: Colored connection accents the header

- **WHEN** the focused connection has color `amber`
- **THEN** the identity header displays an amber accent (stripe/border/tint) using the theme-appropriate amber shade, while the name, engine label, and actions remain fully legible

#### Scenario: Uncolored connection leaves the header unchanged

- **WHEN** the focused connection has no explicit color
- **THEN** the identity header renders with no color accent and the same layout and height as before this change

#### Scenario: Switching focused connection recolors the header immediately

- **WHEN** the user switches from a `blue` connection to a `red` connection
- **THEN** the identity header accent changes from blue to red without a reload

#### Scenario: Header accent respects the active theme

- **WHEN** a connection has color `green` and the app switches between light and dark themes
- **THEN** the header accent uses the theme-appropriate green shade in each theme, preserving contrast

## MODIFIED Requirements

### Requirement: Color is rendered in the connection rail

When a connection in the connection rail has an explicit color, the rail's environment indicator dot SHALL render that color prominently enough to be identifiable at a glance among several connections. When the connection has no explicit color, the rail SHALL fall back to the existing name-based environment heuristic. The color indicator MUST remain a small dot consistent with `DESIGN.md` restraint (no full-item background fills), but SHALL have sufficient size and contrast in both themes that the color is clearly readable.

#### Scenario: Colored connection shows its color in the rail

- **WHEN** an open connection has color `red`
- **THEN** its rail item's indicator dot is rendered in the red palette shade and is clearly distinguishable from other connections' dots

#### Scenario: Uncolored connection falls back to the heuristic

- **WHEN** an open connection has no color and its name contains "prod"
- **THEN** its rail item's indicator dot uses the production (amber) heuristic color, as before

### Requirement: Color is rendered in the sidebar connection row

When a connection has an explicit color, its sidebar row (`ConnectionRow`, in both manager and workspace modes) SHALL display a color marker prominently enough to identify the connection at a glance when scanning a list of rows. When the connection has no color, no marker is shown and the row renders as it does today. The marker MUST stay within `DESIGN.md` restraint (a swatch and/or edge stripe, never a full-row background fill) and MUST NOT replace or obscure the engine icon, the active/connected dot, or the focused-row stripe.

#### Scenario: Colored connection shows a prominent marker in the sidebar

- **WHEN** a connection with color `blue` is listed in the sidebar
- **THEN** a clearly visible blue marker (swatch and/or edge stripe) identifies the row, without obscuring the engine icon, connected dot, or focused-row stripe

#### Scenario: Uncolored connection shows no marker

- **WHEN** a connection with no color is listed in the sidebar
- **THEN** no color marker is rendered and the row layout is unchanged from current behavior
