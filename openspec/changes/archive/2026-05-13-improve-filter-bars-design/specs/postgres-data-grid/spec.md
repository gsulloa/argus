## MODIFIED Requirements

### Requirement: Filter bar surface

The viewer tab SHALL render a filter bar pinned to the top of the data grid, above the column header row and below any tab title chrome. The filter bar MUST be the only filter surface in the data grid — there MUST NOT be a per-column header funnel or popover. Removing the popover MUST NOT remove the existing column-header sort affordance (sort remains accessible from the column header).

The bar MUST always be visible while a `postgres-table-data` tab is mounted; it MUST NOT auto-collapse on scroll. It MAY be collapsed manually by the user via a toggle (chevron) in the bar; the collapsed state MUST NOT discard any draft or applied filters.

The bar MUST contain, in order: a Mode toggle (Structured / Raw SQL), the body for the active mode (the conditions UI for Structured, the WHERE editor for Raw), and an action row with `Reset`, `Apply`, and `Open in SQL Editor`. The `Apply` button MUST be the rightmost primary control.

The bar SHALL conform to every requirement of the `filter-bar-visual-system` capability: it MUST use the shared primitive layer in `src/modules/shared/filter-bar/`, the shared design tokens, the 32/body/32 layout rhythm, the segmented mode toggle primitive, the `box-shadow`-based 3px focus halo on every focusable child, the violet primary button with the layout-stable dirty pip, the keyboard-hint chips (`⌘↵` next to Apply, `⎋` next to Reset), the inline `No filters · + AND row · + OR group` empty-body state, the `var(--surface-2)` hover surface, and the `prefers-reduced-motion: reduce` overrides. The bar MUST NOT reimplement any of the chrome covered by the shared primitives inline.

#### Scenario: Bar is the only filter surface

- **WHEN** the user opens a `postgres-table-data` tab
- **THEN** the filter bar is rendered above the data grid
- **AND** there is no funnel icon or filter popover trigger on any column header

#### Scenario: Sort affordance survives popover removal

- **WHEN** the user clicks a column header
- **THEN** the existing sort cycle (`asc → desc → none`) fires
- **AND** no filter popover is shown

#### Scenario: Collapsing the bar preserves state

- **WHEN** the bar has applied filters and the user toggles the bar collapsed, then expanded
- **THEN** all applied and draft filters are preserved exactly

#### Scenario: Bar uses the shared primitive layer

- **WHEN** the Postgres filter bar is rendered
- **THEN** its shell, header, segmented mode toggle, action-row chrome, "+ AND row" and "+ OR group" buttons, AND/OR connector strips, and keyboard-hint chips are rendered by components imported from `src/modules/shared/filter-bar/`
- **AND** none of those chrome elements are reimplemented inline in `FilterBar.tsx`

#### Scenario: Apply button shows the violet dirty pip

- **WHEN** the bar's draft differs from its applied state
- **THEN** the Apply button renders a 4px violet pip at its top-right corner with a 2px `var(--accent)` ring
- **AND** the Apply button's measured width is identical to its clean-state width

#### Scenario: Empty body is a single inline row

- **WHEN** the bar is in Structured mode with no conditions and no OR groups
- **THEN** the body renders one 24px row reading `No filters · + AND row · + OR group` with `+ AND row` and `+ OR group` clickable
- **AND** no separate empty-message row appears above the add-row buttons
