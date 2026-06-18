## ADDED Requirements

### Requirement: Active entry stays in the list viewport when searching

When the search query changes, the table quick-switcher SHALL keep the active (highlighted, best-ranked) entry visible inside the `Cmdk.List` scroll viewport. A new query MUST NOT leave the active entry scrolled out of view because of a scroll position carried over from a previous query; the list MUST reset its scroll so the top of the freshly ranked results is visible, and the active entry MUST be scrolled into view. The entry that is highlighted/visible MUST be exactly the entry that Enter activates, and this behavior MUST NOT disrupt the empty-search `Recent` group or ↑/↓ keyboard navigation.

#### Scenario: New query brings the best match into view

- **WHEN** the user has scrolled the result list for a previous query and then types a new query whose best-ranked match would otherwise fall outside the viewport
- **THEN** the list scrolls so the active (best-ranked) entry is visible within the `Cmdk.List` viewport

#### Scenario: Stale scroll position does not hide the active entry

- **WHEN** the list was scrolled down by an earlier query and the user replaces the query with a new one
- **THEN** the list does not retain the old scroll offset in a way that leaves the new top result off-screen

#### Scenario: Enter opens the visually highlighted entry

- **WHEN** a query has produced ranked results and the active entry has been scrolled into view
- **AND** the user presses Enter
- **THEN** the relation that is opened is the same entry that is visually highlighted and visible

#### Scenario: Empty search preserves the Recent group

- **WHEN** the user clears the search input back to empty
- **THEN** the `Recent` group renders as before and the scroll-to-active behavior does not hide or reorder it

#### Scenario: Keyboard navigation still scrolls the active row into view

- **WHEN** the user presses ↑ / ↓ to move the highlight beyond the visible rows
- **THEN** the list scrolls to keep the newly highlighted row visible, as with standard cmdk navigation
