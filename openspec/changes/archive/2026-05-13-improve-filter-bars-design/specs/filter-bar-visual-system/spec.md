## ADDED Requirements

### Requirement: Design tokens

The application's global stylesheet (`src/styles/global.css`) SHALL declare the following CSS custom properties for both `:root[data-theme="dark"]` and `:root[data-theme="light"]` so every token referenced by the filter-bar surfaces resolves to a real value. Tokens whose hex values differ between themes are listed per theme; tokens whose values are theme-agnostic (radius, spacing, motion) are declared once at `:root`.

Required tokens:

- Surfaces: `--canvas`, `--elevated`, `--surface`, `--surface-2`, `--hairline`.
- Text: `--text`, `--text-muted`, `--text-subtle`, `--text-inverse`.
- Borders: `--border`, `--border-strong`.
- Accent (violet, per DESIGN.md): `--accent`, `--accent-hover`, `--accent-soft`, `--accent-glow`, `--accent-text`.
- Semantic: `--success`, `--warning`, `--danger`, `--info`.
- Typography: `--font-stack`, `--font-mono`.
- Radii: `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-full`.
- Spacing: `--space-2xs`, `--space-xs`, `--space-sm`, `--space-md`, `--space-lg`, `--space-xl`.
- Motion: `--duration-instant`, `--duration-short`, `--duration-medium`, `--duration-long`.

Dark-theme accent SHALL resolve to `#A855F7` (`--accent`), `#C084FC` (`--accent-hover`), `rgba(168,85,247,0.12)` (`--accent-soft`), `rgba(168,85,247,0.18)` (`--accent-glow`). Light-theme accent SHALL resolve to `#7C3AED` / `#6D28D9` / `rgba(124,58,237,0.10)` / `rgba(124,58,237,0.16)` respectively. The previous blue accent values MUST NOT remain in either theme.

#### Scenario: All filter-bar tokens resolve in dark theme

- **WHEN** the app is rendered with `data-theme="dark"` and a Postgres filter bar or a Dynamo query builder is mounted
- **THEN** every CSS custom property referenced by the bar's stylesheets resolves to a declared value (no `initial`/`unset` fallback occurs for any of: `--canvas`, `--elevated`, `--surface`, `--surface-2`, `--hairline`, `--accent`, `--accent-hover`, `--accent-soft`, `--accent-glow`, `--accent-text`, `--text`, `--text-muted`, `--text-subtle`, `--border`, `--border-strong`, `--font-mono`, `--radius-sm`, `--radius-md`, `--space-2xs`, `--space-xs`, `--space-sm`, `--space-md`, `--duration-instant`)

#### Scenario: All filter-bar tokens resolve in light theme

- **WHEN** the app is rendered with `data-theme="light"` and a Postgres filter bar or a Dynamo query builder is mounted
- **THEN** every CSS custom property referenced by the bar's stylesheets resolves to a declared value with the light-theme palette (`--canvas: #FAFAF9`, `--elevated: #FFFFFF`, `--accent: #7C3AED`, etc.)

#### Scenario: Accent is violet, not blue

- **WHEN** the computed style of any element with `color: var(--accent)` is read
- **THEN** the resolved color is the DESIGN.md violet for the active theme (`#A855F7` in dark, `#7C3AED` in light), not the legacy blue (`#3b82f6` / `#2563eb`)

### Requirement: Shell layout rhythm

A filter-bar surface SHALL render with a three-row layout: a header (32px min-height), a flexible body, and an action row (32px min-height). The header and action row MUST be separated from the body by a 1px `var(--border)` hairline. The body's vertical padding MUST be `var(--space-xs)` (8px), its horizontal padding MUST be `var(--space-sm)` (12px), and its inter-row gap MUST be `var(--space-xs)` (8px). The header's and action row's padding MUST be `6px var(--space-sm)`. The bar's outer container MUST use `background: var(--surface)` and MUST sit above the data grid with a 1px `var(--border)` bottom hairline.

#### Scenario: Header and action row are 32px tall

- **WHEN** a filter bar is rendered in its default state
- **THEN** the header row and the action row both have a measured min-height of 32px
- **AND** the body sits between them with `var(--space-xs)` vertical padding on each side of its content

#### Scenario: Body padding follows the spacing scale

- **WHEN** the body of a filter bar renders one or more rows
- **THEN** the body padding is `var(--space-xs)` vertical, `var(--space-sm)` horizontal, and the inter-row gap is `var(--space-xs)`

#### Scenario: Hairlines separate header / body / actions

- **WHEN** any filter bar is rendered with both a header and an action row
- **THEN** a 1px `var(--border)` line sits below the header and above the action row
- **AND** the bar itself has a 1px `var(--border)` bottom hairline against the data grid

### Requirement: Segmented mode toggle

A filter bar that exposes a mode selector (e.g. Structured/Raw SQL for Postgres, Scan/Query for Dynamo) SHALL render it as a single segmented control sharing one primitive. The control MUST:

- Be a horizontal inline-flex container with `border: 1px solid var(--border-strong)` and `border-radius: var(--radius-md)` (5px).
- Have an inner height of 24px (so the segmented control fits inside the 32px header with 4px breathing room top/bottom).
- Render each option with `padding: 3px 10px`, `font-size: 11px`, `font-weight: 500`, `font-family: var(--font-stack)`, `letter-spacing: 0`.
- Render inactive options with `color: var(--text-muted)` over a transparent background.
- Render the active option with `color: var(--accent)` over `background: var(--accent-soft)`.
- Render hover on inactive options with `background: var(--surface-2)` and `color: var(--text)`.
- Separate adjacent options with a 1px `var(--border-strong)` divider (no trailing divider after the last option).
- Show the accent focus halo (see "Focus halo" requirement) when an option has keyboard focus.

#### Scenario: Postgres mode toggle uses the segmented primitive

- **WHEN** the Postgres filter bar's header is rendered
- **THEN** the Structured/Raw SQL toggle is rendered by the shared segmented primitive with `var(--radius-md)` corners and an active state of `color: var(--accent)` over `background: var(--accent-soft)`

#### Scenario: Dynamo mode toggle uses the segmented primitive

- **WHEN** the Dynamo query builder is rendered
- **THEN** the Scan/Query toggle is rendered by the same shared segmented primitive with the same radius, active-state, hover-state, and inter-option divider as the Postgres toggle

#### Scenario: Active option visual is consistent

- **WHEN** any segmented control has an active option
- **THEN** that option renders `color: var(--accent)` (violet, not muted-text), `background: var(--accent-soft)`, no inset border, and `font-weight: 500`

#### Scenario: Hover on inactive option

- **WHEN** the user hovers an inactive option in any segmented control
- **THEN** the option's background becomes `var(--surface-2)` and its color becomes `var(--text)`

### Requirement: Focus halo

Every focusable child of a filter bar (segmented-control options, selects, text inputs, textareas, buttons, picker triggers, "+ row" buttons) SHALL display a 3px focus halo on `:focus-visible` rendered as `box-shadow: 0 0 0 3px var(--accent-glow)` paired with `border-color: var(--accent)`. The halo MUST NOT use the `outline` property (so the rounded corners are preserved on the Safari WebView). When `prefers-reduced-motion: reduce` is set, the halo MUST still appear; only easing/transition declarations are dropped.

#### Scenario: Input focus shows the violet halo

- **WHEN** the user tabs into a value input or a picker trigger inside any filter bar
- **THEN** the element renders `box-shadow: 0 0 0 3px var(--accent-glow)` and `border-color: var(--accent)`

#### Scenario: Segmented option focus shows the halo without breaking corners

- **WHEN** the user tabs to an option inside a segmented mode toggle
- **THEN** the option's halo renders cleanly outside the option's rounded corner, not clipped by the container's `overflow: hidden`

#### Scenario: Reduced-motion users still see the halo

- **WHEN** the user has `prefers-reduced-motion: reduce` set and focuses an element inside any filter bar
- **THEN** the halo appears immediately (no transition)
- **AND** the halo's color and 3px offset are unchanged from the default-motion case

### Requirement: Action row layout

A filter-bar action row SHALL anchor primary actions (Apply for Postgres, Run for Dynamo) at the right edge and secondary actions (Reset, Open in SQL Editor) at the left edge, separated by a flex spacer. The primary button MUST use `background: var(--accent)`, `color: var(--accent-text)`, `border: 1px solid var(--accent)`, `border-radius: var(--radius-md)`, `padding: 4px 12px`, `font-size: 11px`, `font-weight: 500`. Secondary buttons MUST use `background: transparent`, `color: var(--text)`, `border: 1px solid var(--border-strong)`, same radius, same padding, same typography. Disabled buttons MUST reduce to `opacity: 0.5` and `cursor: not-allowed`.

When the bar has unsaved draft state, the primary button SHALL display a dirty pip rendered as a 4px (`var(--space-2xs)`) violet circle positioned at the top-right of the button (offset −2/−2) with a 2px ring of `var(--accent)` against the button's `--accent` face. The pip MUST NOT shift the button's text or change the button's measured width.

#### Scenario: Apply / Run is the rightmost primary control

- **WHEN** any filter bar's action row is rendered
- **THEN** the primary button (Apply for Postgres, Run for Dynamo) is anchored at the right edge of the row
- **AND** secondary buttons (Reset, Open in SQL Editor) sit at the left edge separated by a flex spacer

#### Scenario: Primary button uses the violet accent

- **WHEN** any filter bar's primary button is rendered enabled
- **THEN** its background is `var(--accent)` (violet), its border matches the background, its text color is `var(--accent-text)`, and its radius is `var(--radius-md)`

#### Scenario: Dirty pip is layout-stable

- **WHEN** a filter bar transitions from clean to dirty state
- **THEN** a 4px violet pip with a 2px violet ring appears at the top-right corner of the primary button
- **AND** the primary button's measured width and text baseline are unchanged from the clean state

### Requirement: Keyboard hint chips

A filter-bar action row SHALL render a keyboard-hint chip next to each button whose action is bound to a global shortcut while the bar is focused. Chips MUST render as `<kbd>`-styled spans with `padding: 1px 5px`, `font-family: var(--font-mono)`, `font-size: 10px`, `letter-spacing: 0.16em`, `border: 1px solid var(--border)`, `border-radius: var(--radius-sm)` (3px), `color: var(--text-subtle)`, no background. Chips MUST NOT use the accent color. The chip text MUST be the platform-appropriate glyph (`⌘↵` for Cmd+Enter on macOS, `Ctrl+↵` elsewhere; `⎋` for Escape; `⌘⇧R` for Cmd+Shift+R on macOS).

#### Scenario: Apply chip on Postgres

- **WHEN** the Postgres filter bar's action row is rendered on macOS
- **THEN** a chip reading `⌘↵` sits adjacent to the Apply button with the styling above

#### Scenario: Reset chip on both bars

- **WHEN** either filter bar's action row is rendered
- **THEN** a chip reading `⎋` sits adjacent to the Reset button

#### Scenario: Run + reset chips on Dynamo

- **WHEN** the Dynamo query builder's action row is rendered on macOS
- **THEN** a `⌘↵` chip sits adjacent to the Run button and a `⌘⇧R` chip sits adjacent to the Reset button

#### Scenario: Chips never use the accent

- **WHEN** any keyboard-hint chip is rendered
- **THEN** its `color` resolves to `var(--text-subtle)` and its `background` is transparent — never `var(--accent)` or `var(--accent-soft)`

### Requirement: Empty body state

When a filter bar's body has zero authored rows (zero Postgres conditions and zero OR groups, or zero Dynamo filter rows in the filters section), the body SHALL render a single 24px row containing the muted label `No filters` followed by the add-row affordances inline (separated by a `·` middle-dot in `var(--text-subtle)`). The empty state MUST NOT render the conventional "actions row below" — the add buttons are the only content. The empty-state row MUST use `color: var(--text-subtle)` and `font-size: 11px`.

#### Scenario: Postgres empty body

- **WHEN** the Postgres filter bar is in Structured mode with no conditions and no OR groups
- **THEN** the body renders one 24px row reading `No filters · + AND row · + OR group` where `+ AND row` and `+ OR group` are clickable
- **AND** there is no separate empty-message row above the add-buttons

#### Scenario: Dynamo empty filters section

- **WHEN** the Dynamo query builder's filters section has zero filter rows
- **THEN** the filters section renders one 24px row reading `No filters · + Filter` where `+ Filter` is clickable

#### Scenario: Empty body row is muted

- **WHEN** any empty body state is rendered
- **THEN** its text color is `var(--text-subtle)` and its font size is 11px, and the add-buttons inherit the same baseline

### Requirement: Hover surface

Every interactive child of a filter bar (segmented options, secondary buttons, "+ row" buttons, collapse chevron, picker triggers, select dropdowns) SHALL use `background: var(--surface-2)` on hover when not active and not disabled. No filter-bar surface MUST use `var(--bg-hover)` or any ad-hoc `rgba()` hover treatment.

#### Scenario: Secondary button hover

- **WHEN** the user hovers a secondary button (Reset, Open in SQL Editor)
- **THEN** its background becomes `var(--surface-2)`

#### Scenario: Picker trigger hover

- **WHEN** the user hovers a column picker, operator picker, or attribute-name field
- **THEN** its background becomes `var(--surface-2)`

#### Scenario: Collapse chevron hover

- **WHEN** the user hovers the collapse chevron in the Postgres filter bar header
- **THEN** its color shifts from `var(--text-subtle)` to `var(--text)` and its background becomes `var(--surface-2)`

### Requirement: Reduced motion

When `prefers-reduced-motion: reduce` is set, every filter-bar transition declaration (currently 80ms hover transitions on segmented options and pickers) SHALL be removed via a `@media (prefers-reduced-motion: reduce)` block. Color and background changes MUST still occur instantaneously; only the easing/transition is dropped.

#### Scenario: Reduced motion removes 80ms transitions

- **WHEN** `prefers-reduced-motion: reduce` is active and the user hovers a segmented option
- **THEN** the hover color/background change applies with no transition duration

#### Scenario: Reduced motion preserves focus halo

- **WHEN** `prefers-reduced-motion: reduce` is active and the user focuses an input
- **THEN** the 3px `var(--accent-glow)` halo still appears at full opacity

### Requirement: Shared primitive components

The visual contracts above SHALL be implemented by a shared primitive layer in `src/modules/shared/filter-bar/` exporting at minimum: `FilterBarShell`, `FilterBarHeader`, `FilterBarBody`, `FilterBarActions`, `FilterSegmentedToggle`, `FilterTypeBadge`, `FilterConnector`, `FilterRowAddButton`, `FilterKeyHint`. Both the Postgres filter bar and the Dynamo query builder MUST compose these primitives rather than reimplementing the chrome inline. Each primitive MUST be presentational (no business logic, no module-specific state).

#### Scenario: Primitive layer exists and is consumed by Postgres

- **WHEN** the Postgres `FilterBar.tsx` is rendered
- **THEN** its shell, header chrome, segmented mode toggle, action-row chrome, "+ AND row" / "+ OR group" buttons, and connector strips are rendered by components imported from `src/modules/shared/filter-bar/`

#### Scenario: Primitive layer is consumed by Dynamo

- **WHEN** the Dynamo `QueryBuilder.tsx` is rendered
- **THEN** its shell, header chrome, segmented mode toggle, action-row chrome, type badges, key-hint chips, and "+ Filter" button are rendered by the same primitives imported from `src/modules/shared/filter-bar/`

#### Scenario: Primitives are presentational only

- **WHEN** any shared primitive is imported and rendered
- **THEN** the primitive's props are limited to layout/content/event-callback inputs (no module-specific state lookups, no Tauri command dispatch, no draft/applied logic)
