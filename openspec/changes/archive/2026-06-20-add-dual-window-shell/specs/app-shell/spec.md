## MODIFIED Requirements

### Requirement: Application window

The system SHALL launch the **Connection Manager** window on application start, titled "Argus", with native window decorations on the host operating system. The application SHALL additionally create, on demand, a single **Workspace** window (see the `dual-window-shell` and `connection-rail` capabilities). The two windows have fixed roles determined by their window label (`manager`, `workspace`). Each window's size and position MUST persist across launches, keyed by its window label. On first launch (no persisted geometry) the Manager SHALL open at a compact, picker-appropriate default size, and the Workspace SHALL open at a larger work-appropriate default size.

#### Scenario: First launch shows the Manager window

- **WHEN** the user launches Argus for the first time
- **THEN** a window titled "Argus" appears with the system-default chrome showing the Connection Manager
- **AND** it opens at a compact, picker-appropriate default size (not the larger workspace size)
- **AND** no Workspace window exists until the user opens a connection

#### Scenario: Window geometry persists per window

- **WHEN** the user resizes or moves either the Manager or the Workspace and quits
- **AND** relaunches Argus
- **THEN** each window reopens at its previously chosen size and position

#### Scenario: Closing the last window quits the application

- **WHEN** the user closes the Manager while no Workspace exists, on Windows or Linux
- **THEN** the application terminates cleanly (no orphan processes, SQLite handle closed)

### Requirement: Center tab system

The **Workspace** center work area SHALL host a tab strip. Tabs MUST be opened, switched, closed, and reordered by drag. Each tab is rendered by a registered renderer keyed on the tab's `kind`. Tabs SHALL be **scoped to the focused connection**: each open connection has its own tab set, and the visible tab strip is the focused connection's set. Opening, closing, cycling, and ⌘W operate within the focused connection's set. There is no `welcome` tab kind — the Connection Manager is the welcome surface.

#### Scenario: Tabs are scoped per connection

- **WHEN** connection A is focused and the user opens two object tabs, then focuses connection B in the rail
- **THEN** the tab strip shows B's tab set (not A's)
- **AND** focusing A again restores A's two tabs and its active tab

#### Scenario: Closing the last tab of the focused connection

- **WHEN** the user closes the only open tab of the focused connection
- **THEN** the Workspace center area shows an empty placeholder for that connection with a hint to open an object or the command palette (⌘K)

#### Scenario: Switching tabs with keyboard

- **WHEN** more than one tab is open for the focused connection and the user presses ⌃Tab (Ctrl+Tab) or ⌃⇧Tab
- **THEN** focus moves to the next or previous tab within the focused connection's set

#### Scenario: Closing a tab with keyboard

- **WHEN** any tab of the focused connection is active and the user presses ⌘W (Cmd+W) or Ctrl+W
- **THEN** that tab closes; if it was the active tab, the previous tab in the same connection's set becomes active

### Requirement: Base keyboard shortcuts

The shell SHALL register base shortcuts at startup, partitioned by window role.

The **Workspace** SHALL register: ⌘K (Cmd+K) opens the command palette, ⌘⇧P is a synonym for ⌘K, ⌘P opens the table quick-switcher **scoped to the focused connection**, ⌥⌘P opens the table quick-switcher **scoped to all open connections**, ⌘W closes the active tab of the focused connection, ⌘\ toggles the right inspector, ⌘, opens settings.

The **Manager** SHALL register: ⌘K (Cmd+K) opens the command palette and ⌘⇧P as its synonym, and ⌘, opens settings. ⌘P / ⌥⌘P and ⌘W have no effect in the Manager (no tabs, no per-connection table index).

These shortcuts MUST fire regardless of the focused element, including inside a CodeMirror SQL editor surface (`.cm-content` contenteditable), a native `<input>`, `<textarea>`, `<select>`, or any other contenteditable region. The handler MUST call `event.preventDefault()` on match so the keystroke does not also reach the underlying editor or input.

#### Scenario: Opening the palette with ⌘K

- **WHEN** the user presses ⌘K (or Ctrl+K on non-macOS) in either window
- **THEN** the command palette opens centered over that window

#### Scenario: ⌘P scopes to the focused connection

- **WHEN** the Workspace has connections A and B open with A focused, and the user presses ⌘P
- **THEN** the table quick-switcher opens listing only A's relations

#### Scenario: ⌥⌘P scopes to all open connections

- **WHEN** the Workspace has connections A and B open and the user presses ⌥⌘P
- **THEN** the table quick-switcher opens listing relations from both A and B

#### Scenario: Shortcuts fire from inside the SQL editor

- **WHEN** the user has focus inside a `postgres-query` tab's CodeMirror editor (`.cm-content` is the active element)
- **AND** the user presses ⌘K
- **THEN** the command palette opens
- **AND** the editor document is unchanged (no character inserted, no edit transaction dispatched)

#### Scenario: Tab close shortcut fires from a focused input

- **WHEN** the user has focus inside any `<input>` or `<textarea>` in the Workspace
- **AND** the user presses ⌘W
- **THEN** the active tab of the focused connection is closed
- **AND** no character is inserted into the input

### Requirement: Sidebar sections may host hierarchical subtrees

In the **Workspace**, the level-2 area SHALL host a `SidebarTree` for the **focused connection only**. The Workspace MUST provide a single vertical scroll context containing the focused connection's tree; the tree MUST grow to its natural content height and contribute to that scroll rather than scrolling independently, and MUST respect the persisted Workspace sidebar width. Trees for non-focused open connections MUST NOT be rendered at level 2 (their existence is represented only by their rail item).

Embedded subtrees MAY be of any depth from 1 to N. A **flat subtree** (depth 1) is a fully supported shape and MUST receive the same scroll-context, width, virtualization, keyboard, and ARIA behavior as a deeper subtree. Module owners pick the depth that fits the underlying data model: the Postgres module renders a multi-level subtree (schema → groups → relations → indexes/triggers); the Dynamo module renders a flat subtree (one leaf per table).

#### Scenario: Only the focused connection's tree renders

- **WHEN** connections A and B are open and A is focused
- **THEN** the level-2 area renders A's `SidebarTree`
- **AND** B's tree is not rendered at level 2

#### Scenario: Sidebar provides a single scroll context

- **WHEN** the focused connection's tree exceeds the visible level-2 height
- **THEN** the Workspace exposes one vertical scrollbar for that tree

#### Scenario: Sidebar width applies to the focused tree

- **WHEN** the user resizes the Workspace sidebar to a new width
- **THEN** the focused connection's `SidebarTree` lays out within the new width, truncating long labels with an ellipsis and exposing them via tooltip on hover

#### Scenario: Virtualized tree uses the sidebar scroll context

- **WHEN** the focused connection's `SidebarTree` exceeds its virtualization threshold (more than 500 visible nodes)
- **THEN** the tree's virtualizer measures and positions rows against the Workspace sidebar's shared scroll element

#### Scenario: Flat subtree is a supported shape

- **WHEN** the focused connection is a Dynamo connection whose nodes are all leaves at depth 1
- **THEN** the tree renders without intermediate group rows
- **AND** keyboard navigation, virtualization above the 500-node threshold, ARIA `tree`/`treeitem` semantics, and the shared scroll context behave identically to multi-level trees

### Requirement: Sidebar connection kind picker

The **Connection Manager** SHALL own connection creation. Its "+" affordance in the connections list opens a small menu whose first item, "New connection", opens a **kind picker** rather than going directly to a kind-specific form. The kind picker MUST render one selectable card per supported connection kind (currently `postgres` and `dynamodb`), each showing the kind's icon, display name, and a one-line description. Activating a card MUST open that kind's connection form. The picker MUST be dismissable with `Escape` and via Cancel, in which case no form is opened.

Connection rows in the Manager SHALL dispatch their icon by the row's `kind`: `postgres` rows render the Postgres icon, `dynamodb` rows render the Dynamo icon, and rows with an unknown `kind` fall back to rendering the kind value as plain text. The primary action of a Manager connection row is **open in the Workspace** (per the `dual-window-shell` open-and-focus coordination), not an inline connect that expands a subtree.

#### Scenario: Plus button opens kind picker

- **WHEN** the user clicks the "+" button in the Manager's connections list and activates "New connection"
- **THEN** a kind picker dialog opens with at least one card per supported kind (`postgres`, `dynamodb`)

#### Scenario: Picking a kind opens its form

- **WHEN** the kind picker is open and the user activates the PostgreSQL card
- **THEN** the Postgres connection form opens with empty fields and the kind picker closes

#### Scenario: Escape cancels the kind picker

- **WHEN** the kind picker is open and the user presses Escape (or clicks Cancel)
- **THEN** the picker closes and no form opens

#### Scenario: Manager row opens the connection in the Workspace

- **WHEN** the user activates a connection row in the Manager
- **THEN** the connection is opened into the Workspace and focused there (per `dual-window-shell`)
- **AND** the row does not expand an inline schema subtree in the Manager
