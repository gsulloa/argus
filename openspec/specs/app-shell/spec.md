# app-shell Specification

## Purpose
TBD - created by archiving change bootstrap-tauri-shell. Update Purpose after archive.
## Requirements
### Requirement: Application window

The system SHALL launch a single main desktop window on application start, titled "Argus", sized to a sensible default (1280x800), and positioned with native window decorations on the host operating system.

#### Scenario: First launch shows the main window

- **WHEN** the user launches Argus for the first time
- **THEN** a window titled "Argus" appears at 1280x800 with the system-default chrome and an empty shell

#### Scenario: Closing the window quits the application

- **WHEN** the user closes the only main window on macOS, Linux, or Windows
- **THEN** the application terminates cleanly (no orphan processes, SQLite handle closed)

### Requirement: Four-region layout

The shell SHALL present four regions: a left sidebar, a center work area containing tabs, a right inspector panel, and a bottom status bar. The right inspector panel MUST be collapsible. The left sidebar MUST be resizable horizontally with the resize handle persisted across launches.

#### Scenario: Default layout on first launch

- **WHEN** the user launches Argus with no prior preferences
- **THEN** the window shows a left sidebar (~240px), a center area, a collapsed-by-default right inspector, and a bottom status bar

#### Scenario: Toggling the right inspector

- **WHEN** the user presses ⌘\ (Cmd+Backslash) on macOS or Ctrl+\ elsewhere, or clicks the inspector toggle in the status bar
- **THEN** the right inspector panel toggles between collapsed and expanded states

#### Scenario: Sidebar width persists across launches

- **WHEN** the user drags the sidebar resize handle to a new width and quits
- **AND** the user relaunches Argus
- **THEN** the sidebar opens at the previously chosen width

### Requirement: Center tab system

The center work area SHALL host a tab strip. Tabs MUST be opened, switched, closed, and reordered by drag. Each tab is rendered by a registered renderer keyed on the tab's `kind`. The platform SHALL ship with a single built-in `welcome` tab kind that shows a static welcome view; module-specific kinds are registered by other capabilities.

#### Scenario: Default welcome tab on first launch

- **WHEN** the user launches Argus with no saved tab state
- **THEN** the center area shows a single tab of kind `welcome` with a static welcome view

#### Scenario: Closing the last tab

- **WHEN** the user closes the only open tab
- **THEN** the center area shows an empty placeholder with a hint to open the command palette (⌘K)

#### Scenario: Switching tabs with keyboard

- **WHEN** more than one tab is open and the user presses ⌃Tab (Ctrl+Tab) or ⌃⇧Tab
- **THEN** focus moves to the next or previous tab respectively

#### Scenario: Closing a tab with keyboard

- **WHEN** any tab is focused and the user presses ⌘W (Cmd+W) or Ctrl+W
- **THEN** that tab closes; if it was the active tab, the previous tab becomes active

### Requirement: Theming

The shell SHALL support `light`, `dark`, and `system` theme modes. The active theme is persisted in the local settings store and applied via a `data-theme` attribute on the document root. When mode is `system`, the theme MUST follow the OS-level color scheme and update live when it changes.

#### Scenario: Following the system theme

- **WHEN** the user has theme mode set to `system` and the OS color scheme is dark
- **THEN** the application renders with the dark theme variables active

#### Scenario: Live update when system changes

- **WHEN** the user has theme mode set to `system` and the OS color scheme switches from dark to light at runtime
- **THEN** the application updates to the light theme without a relaunch

#### Scenario: Persisting an explicit choice

- **WHEN** the user picks `dark` explicitly and quits
- **AND** the user relaunches with the OS in light mode
- **THEN** the application opens in the dark theme

### Requirement: Base keyboard shortcuts

The shell SHALL register the following base shortcuts at startup, available globally inside the application window: ⌘K (Cmd+K) opens the command palette, ⌘⇧P is a synonym for ⌘K, ⌘W closes the active tab, ⌘\ toggles the right inspector, ⌘, opens settings (no settings UI yet — opens an empty placeholder tab).

#### Scenario: Opening the palette with ⌘K

- **WHEN** the user presses ⌘K (or Ctrl+K on non-macOS)
- **THEN** the command palette opens centered over the window

#### Scenario: Settings shortcut

- **WHEN** the user presses ⌘, (or Ctrl+, on non-macOS)
- **THEN** a tab of kind `settings-placeholder` opens (or focuses if already open)

### Requirement: Native edit menu

On macOS the application SHALL provide a native menu bar with at minimum the standard `Edit` menu (Undo, Redo, Cut, Copy, Paste, Select All) so that text inputs respect platform conventions.

#### Scenario: Copy and paste in an input

- **WHEN** the user focuses any text input and presses ⌘C followed by ⌘V
- **THEN** the system clipboard is used for copy and paste as expected on the host OS

### Requirement: Sidebar tree primitive

The shell SHALL provide a reusable `SidebarTree` primitive that renders a hierarchical, keyboard-navigable tree inside any sidebar section. The primitive MUST implement ARIA `tree` and `treeitem` semantics with single-select and multi-expand behavior, and MUST NOT depend on any module-specific code (no Postgres / Dynamo / CloudWatch imports). Consumers pass in nodes plus render functions for icons and badges; the primitive owns layout, expand/collapse state, selection, and keyboard handling.

#### Scenario: ARIA roles are present

- **WHEN** any sidebar section renders content via `SidebarTree`
- **THEN** the root container has `role="tree"` and every node has `role="treeitem"` with `aria-level`, `aria-expanded` (for parent nodes), and `aria-selected` reflecting state

#### Scenario: Keyboard navigation

- **WHEN** focus is on a tree node and the user presses the Down Arrow key
- **THEN** focus moves to the next visible node
- **AND** Up Arrow moves to the previous visible node
- **AND** Right Arrow expands a collapsed parent or moves into the first child of an expanded parent
- **AND** Left Arrow collapses an expanded parent or moves to the parent of a leaf
- **AND** Enter activates the focused node by calling the consumer's `onActivate` callback
- **AND** Home jumps to the first visible node, End to the last
- **AND** typing a printable character begins a type-ahead search that focuses the next visible node whose label starts with the typed prefix (case-insensitive)

#### Scenario: Virtualization above 500 visible nodes

- **WHEN** a tree has more than 500 visible nodes after expansion
- **THEN** the primitive virtualizes the scroller (rendering only the visible window of nodes); keyboard navigation still works across the full node list, not only the rendered subset

#### Scenario: Plain DOM below threshold

- **WHEN** a tree has 500 or fewer visible nodes
- **THEN** the primitive renders all nodes as plain DOM (no virtualization), to keep small trees crisp and easy to inspect

### Requirement: Sidebar sections may host hierarchical subtrees

The sidebar SHALL allow each section (for example "Connections", or future module-specific sections) to host a `SidebarTree` underneath one or more of its rows. Trees MUST scroll independently from the rest of the sidebar when their content exceeds the available height, and MUST respect the persisted sidebar width.

#### Scenario: Multiple trees can be visible simultaneously

- **WHEN** two connections in the "Connections" section are both active and each renders its own subtree
- **THEN** both trees are rendered in document order under their respective rows; each scrolls independently when its content overflows

#### Scenario: Sidebar width applies to embedded trees

- **WHEN** the user resizes the sidebar to a new width
- **THEN** every visible `SidebarTree` lays out within the new width, truncating long labels with an ellipsis and exposing them via tooltip on hover

