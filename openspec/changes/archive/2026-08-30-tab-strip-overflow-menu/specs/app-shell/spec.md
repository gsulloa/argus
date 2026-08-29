## ADDED Requirements

### Requirement: Tab strip overflow

The Workspace tab strip SHALL bound its own width instead of growing without limit.
Tabs MUST shrink toward a minimum width as more are opened, and a tab label that no
longer fits MUST be truncated with an ellipsis while exposing the full title as a
native tooltip. The dirty indicator and the close button MUST NOT shrink or truncate.

When one or more tabs of the focused connection are not **fully** visible within the
strip's visible region, the strip SHALL render a single overflow control pinned to its
right end, outside the scrolling region, displaying the count of tabs that are not
fully visible. When every tab is fully visible the control MUST NOT be rendered.

Activating the overflow control SHALL open a menu listing exactly the tabs that are not
fully visible, in tab order, each showing its title (ellipsised when long) and its
dirty indicator when dirty. Selecting an entry SHALL activate that tab through the same
switch guard used by clicking a tab in the strip (`shouldActivateTab` for the tab being
left); when that guard resolves to `false` the tab MUST NOT be activated. The menu
lists tabs of the focused connection only, and MUST NOT expose tabs belonging to any
other connection.

The menu SHALL offer activation only. If a close action is ever offered from this menu,
it MUST route through the existing close guard (`shouldCloseTab`) rather than calling
`close` directly.

Whenever the active tab of the focused connection changes — by strip click, ⌃Tab
cycling, the command palette, the table quick-switcher, the overflow menu, or opening a
new tab — the strip SHALL bring the newly active tab fully into its visible region by
the minimum scroll distance required. An active tab that is already fully visible MUST
NOT cause any scrolling. Scrolling performed manually by the user MUST NOT be
overridden until the active tab changes again.

Drag-to-reorder, the per-tab close button, the dirty indicator, ⌘W, and the
per-connection scoping of the tab set MUST continue to behave as specified by the
"Center tab system" requirement.

#### Scenario: Labels truncate before the strip overflows

- **WHEN** enough tabs are open that their natural widths exceed the strip's width, but
  not so many that they hit their minimum width
- **THEN** each tab shrinks and its title is truncated with an ellipsis
- **AND** hovering a truncated tab shows its full title as a tooltip
- **AND** no overflow control is shown

#### Scenario: Overflow control appears with a hidden-tab count

- **WHEN** the focused connection has more tabs than fit at their minimum width, so
  that three of them are not fully visible
- **THEN** an overflow control appears pinned at the right end of the strip
- **AND** it reports that 3 tabs are hidden

#### Scenario: Overflow control disappears when everything fits

- **WHEN** the overflow control is visible and the user closes tabs until every
  remaining tab is fully visible
- **THEN** the overflow control is no longer rendered

#### Scenario: Menu lists only the tabs that do not fit, in tab order

- **WHEN** the user opens the overflow menu while tabs 6, 7 and 8 of 8 are not fully
  visible
- **THEN** the menu lists exactly those three tabs, in tab order
- **AND** each entry shows its title, with a dirty indicator on any tab marked dirty

#### Scenario: Selecting a tab from the menu activates and reveals it

- **WHEN** the user selects a hidden tab from the overflow menu
- **THEN** that tab becomes the active tab of the focused connection
- **AND** the strip scrolls it fully into view
- **AND** it no longer appears in the overflow menu

#### Scenario: A switch guard can cancel activation from the menu

- **WHEN** the currently active tab has registered an activate guard that resolves to
  `false`, and the user selects a different tab from the overflow menu
- **THEN** the active tab does not change

#### Scenario: A tab activated by keyboard is scrolled into view

- **WHEN** more tabs are open than fit and the user presses ⌃Tab until the active tab
  is one that was outside the visible region
- **THEN** the strip scrolls that tab fully into view

#### Scenario: A tab activated from the command palette is scrolled into view

- **WHEN** the user activates an off-screen tab of the focused connection from the
  command palette or the table quick-switcher
- **THEN** the strip scrolls that tab fully into view

#### Scenario: Manual scrolling is not overridden

- **WHEN** the user scrolls the tab strip manually so that the active tab is no longer
  visible, and does not activate a different tab
- **THEN** the strip stays where the user scrolled it
- **AND** the active tab is counted among the hidden tabs in the overflow control

#### Scenario: Overflow is scoped to the focused connection

- **WHEN** connection A has many tabs and connection B has two, and the user focuses B
- **THEN** the strip shows B's two tabs with no overflow control
- **AND** the overflow menu, when A is focused again, lists only A's hidden tabs

#### Scenario: Reordering and closing still work under overflow

- **WHEN** the overflow control is visible and the user drags a visible tab to a new
  position, then closes another visible tab with its × button
- **THEN** the reorder and the close behave as they do without overflow
- **AND** the hidden-tab count updates to reflect the new layout
