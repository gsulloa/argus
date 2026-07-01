## MODIFIED Requirements

### Requirement: Center tab system

The **Workspace** center work area SHALL host a tab strip. Tabs MUST be opened, switched, closed, and reordered by drag. Each tab is rendered by a registered renderer keyed on the tab's `kind`. Tabs SHALL be **scoped to the focused connection**: each open connection has its own tab set, and the visible tab strip is the focused connection's set. Opening, closing, cycling, and ⌘W operate within the focused connection's set. There is no `welcome` tab kind — the Connection Manager is the welcome surface.

When a tab is opened for a connection that is **not** the currently focused connection (for example, opening a saved query bound to another connection), opening the tab SHALL switch the focused connection to that connection so the newly opened (or re-focused) tab becomes visible in the tab strip. A tab-open request MUST NOT deposit a tab into a hidden, non-focused connection set without surfacing it. When an open request cannot resolve any target connection, the request MUST NOT be silently discarded; callers are responsible for resolving a target or surfacing an affordance to the user.

#### Scenario: Tabs are scoped per connection

- **WHEN** connection A is focused and the user opens two object tabs, then focuses connection B in the rail
- **THEN** the tab strip shows B's tab set (not A's)
- **AND** focusing A again restores A's two tabs and its active tab

#### Scenario: Opening a tab for a non-focused connection switches focus

- **WHEN** connection A is focused and a tab is opened for live connection B
- **THEN** the focused connection switches to B
- **AND** the tab strip shows B's set with the newly opened tab active

#### Scenario: Closing the last tab of the focused connection

- **WHEN** the user closes the only open tab of the focused connection
- **THEN** the Workspace center area shows an empty placeholder for that connection with a hint to open an object or the command palette (⌘K)

#### Scenario: Switching tabs with keyboard

- **WHEN** more than one tab is open for the focused connection and the user presses ⌃Tab (Ctrl+Tab) or ⌃⇧Tab
- **THEN** focus moves to the next or previous tab within the focused connection's set

#### Scenario: Closing a tab with keyboard

- **WHEN** any tab of the focused connection is active and the user presses ⌘W (Cmd+W) or Ctrl+W
- **THEN** that tab closes; if it was the active tab, the previous tab in the same connection's set becomes active
