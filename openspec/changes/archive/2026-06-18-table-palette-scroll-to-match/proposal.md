## Why

The table quick-switcher (⌘P) already ranks the best matching relation to the top of the list, but the scrollable list container does not follow that selection: when the active/best-ranked row falls outside the current viewport (e.g. after a previous query left the list scrolled, or in a long result set), the user cannot see which entry Enter will open. The ranking is correct but the affordance is invisible.

## What Changes

- When the search query changes, the table quick-switcher MUST keep the active (best-ranked) row visible inside the `Cmdk.List` viewport — scrolling it into view and/or resetting the list scroll to the top of the fresh result set.
- The fix MUST preserve existing behaviour: the `Recent` group on empty search, keyboard ↑/↓ navigation, and Enter activating exactly the highlighted/visible row.
- No change to ranking logic (`scoreTableEntry`) — only to the scroll/viewport coupling between the active item and the list container.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `table-quick-switcher`: Add a requirement that the active/best-ranked entry stays within the list viewport when the search query changes, so the row Enter will activate is always visible.

## Impact

- `packages/app/src/platform/command-palette/TablePalette.tsx` — owns `search` state and renders the `Cmdk` groups; likely site for syncing the cmdk active value / triggering scroll on query change.
- `packages/app/src/platform/command-palette/PaletteShell.tsx` — owns the `Cmdk` root (`value={undefined}`) and the `Cmdk.List` container; may need to expose or manage the controlled `value` / list ref so the active item scrolls into view.
- No backend, no API, no persistence changes. Cross-engine (Postgres / MySQL / MSSQL) since the switcher is engine-agnostic at the list level.
