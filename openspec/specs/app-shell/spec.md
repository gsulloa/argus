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

The shell SHALL present four primary regions: a left sidebar, a center work area containing tabs, a right inspector panel, and a bottom status bar. The right inspector panel MUST be collapsible. The left sidebar MUST be resizable horizontally with the resize handle persisted across launches. In addition, the shell SHALL accommodate an optional bottom panel slot between the center work area and the status bar (see "Bottom panel slot"); when a panel is active in that slot, the visual region count effectively becomes five, but the four primary regions MUST continue to behave as specified.

#### Scenario: Default layout on first launch

- **WHEN** the user launches Argus with no prior preferences
- **THEN** the window shows a left sidebar (~240px), a center area, a collapsed-by-default right inspector, no active bottom panel, and a bottom status bar

#### Scenario: Toggling the right inspector

- **WHEN** the user presses ⌘\ (Cmd+Backslash) on macOS or Ctrl+\ elsewhere, or clicks the inspector toggle in the status bar
- **THEN** the right inspector panel toggles between collapsed and expanded states

#### Scenario: Sidebar width persists across launches

- **WHEN** the user drags the sidebar resize handle to a new width and quits
- **AND** the user relaunches Argus
- **THEN** the sidebar opens at the previously chosen width

#### Scenario: Bottom panel does not interfere with inspector toggling

- **WHEN** the activity-log bottom panel is open and the user toggles the inspector
- **THEN** the inspector opens or closes normally and the bottom panel keeps its current height

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

The shell SHALL register the following base shortcuts at startup, available globally inside the application window: ⌘K (Cmd+K) opens the command palette, ⌘⇧P is a synonym for ⌘K, ⌘P opens the table quick-switcher, ⌘W closes the active tab, ⌘\ toggles the right inspector, ⌘, opens settings (no settings UI yet — opens an empty placeholder tab).

These shortcuts MUST fire regardless of the focused element. In particular, they MUST work when focus is inside a CodeMirror SQL editor surface (whose `.cm-content` element is `contenteditable`), inside a native `<input>`, `<textarea>`, or `<select>`, or inside any other contenteditable region. The handler MUST call `event.preventDefault()` on match so the keystroke does not also reach the underlying editor or input as a textual command.

#### Scenario: Opening the palette with ⌘K

- **WHEN** the user presses ⌘K (or Ctrl+K on non-macOS)
- **THEN** the command palette opens centered over the window

#### Scenario: Settings shortcut

- **WHEN** the user presses ⌘, (or Ctrl+, on non-macOS)
- **THEN** a tab of kind `settings-placeholder` opens (or focuses if already open)

#### Scenario: Shortcuts fire from inside the SQL editor

- **WHEN** the user has focus inside a `postgres-query` tab's CodeMirror editor (`.cm-content` is the active element)
- **AND** the user presses ⌘K
- **THEN** the command palette opens
- **AND** the editor document is unchanged (no character inserted, no edit transaction dispatched)

#### Scenario: ⌘P opens the table quick-switcher from the SQL editor

- **WHEN** the user has focus inside the SQL editor
- **AND** the user presses ⌘P
- **THEN** the table quick-switcher opens

#### Scenario: Tab close shortcut fires from a focused input

- **WHEN** the user has focus inside any `<input>` or `<textarea>` (e.g. the connection name field, a filter bar, the palette search)
- **AND** the user presses ⌘W
- **THEN** the active tab is closed
- **AND** no character is inserted into the input

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

The sidebar SHALL allow each section (for example "Connections", or future module-specific sections) to host a `SidebarTree` underneath one or more of its rows. The sidebar MUST provide a single vertical scroll context that contains every section and every embedded `SidebarTree` below the brand header; embedded trees MUST grow to their natural content height and contribute to that shared scroll rather than scrolling independently. Embedded trees MUST respect the persisted sidebar width.

Embedded subtrees MAY be of any depth from 1 to N. A **flat subtree** (depth 1 — all children of the row are leaf nodes with no intermediate group nodes) is a fully supported shape and MUST receive the same scroll-context, width, virtualization, keyboard, and ARIA behavior as a deeper subtree. Module owners pick the depth that fits the underlying data model: the Postgres module renders a multi-level subtree (schema → groups → relations → indexes/triggers); the Dynamo module renders a flat subtree (one leaf per table); future modules MAY render either shape without changes to the sidebar primitive.

#### Scenario: Sidebar provides a single scroll context

- **WHEN** the combined height of the sidebar's sections and embedded trees exceeds the visible sidebar height
- **THEN** the sidebar exposes one vertical scrollbar that scrolls every section and embedded tree as a single column
- **AND** the brand header at the top of the sidebar remains visible (does not scroll out of view)

#### Scenario: Multiple trees scroll together

- **WHEN** two connections in the "Connections" section are both active and each renders its own subtree
- **THEN** both trees are rendered in document order under their respective rows
- **AND** scrolling the sidebar moves through both trees as part of the same scroll context (no independent per-tree scrollbars)

#### Scenario: Sidebar width applies to embedded trees

- **WHEN** the user resizes the sidebar to a new width
- **THEN** every visible `SidebarTree` lays out within the new width, truncating long labels with an ellipsis and exposing them via tooltip on hover

#### Scenario: Virtualized trees use the sidebar scroll context

- **WHEN** an embedded `SidebarTree` exceeds its virtualization threshold (more than 500 visible nodes)
- **THEN** the tree's virtualizer measures and positions rows against the sidebar's shared scroll element
- **AND** scrolling the sidebar reveals additional virtualized rows as they enter the viewport

#### Scenario: Flat subtree is a supported shape

- **WHEN** a module embeds a `SidebarTree` whose nodes are all leaves at depth 1 (no group nodes)
- **THEN** the tree renders without any intermediate group rows
- **AND** keyboard navigation, virtualization above the 500-node threshold, ARIA `tree`/`treeitem` semantics, and the shared sidebar scroll context behave identically to multi-level trees

#### Scenario: Heterogeneous depths coexist in the same sidebar

- **WHEN** the sidebar simultaneously hosts a multi-level Postgres subtree under one connection row and a flat Dynamo subtree under another connection row
- **THEN** both subtrees render in document order under their respective rows and participate in the single sidebar scroll context
- **AND** neither subtree's behavior interferes with the other

### Requirement: Bottom panel slot

The shell SHALL provide a bottom panel slot positioned between the center work area and the status bar. The slot MUST be optional — when no bottom panel is registered or active, the shell layout MUST collapse the slot to zero height with no DOM presence and the center work area MUST occupy the freed space. When a bottom panel is active, the slot MUST honor a height controlled by the panel's owner (within slot-imposed bounds 120px–480px) and MUST expose a 4px horizontal drag handle along its top edge that follows the same `useDragHandle` pattern as the sidebar/inspector handles. The slot MUST span the full width of the shell (`grid-column: 1 / -1`).

#### Scenario: No active bottom panel collapses the slot

- **WHEN** no capability has registered or activated a bottom panel
- **THEN** the layout grid renders without a row for the slot and the center area extends down to the status-bar boundary

#### Scenario: Active bottom panel reserves a row

- **WHEN** the activity-log panel is active and open at 240px
- **THEN** the layout grid has a 240px row above the status bar and a 4px drag handle row immediately above it

#### Scenario: Drag handle resizes the slot

- **WHEN** the user drags the bottom-panel handle up by 60px
- **THEN** the slot height grows by 60px (subject to the 120–480 clamp)

### Requirement: Status bar displays current app version

The status bar SHALL display the current app version on its right-hand side at all times, in muted text styled per `DESIGN.md` (the existing neutral/secondary text color, not an accent). The version string MUST be obtained at runtime via `getVersion()` from `@tauri-apps/api/app` so it always reflects the binary that is actually running. The version display MUST persist across all tabs, all panel states, and all connection states — it is never hidden or replaced.

#### Scenario: Version visible on first launch

- **WHEN** the user launches Argus Beta v0.1.5 for the first time
- **THEN** the status bar's right side shows `v0.1.5` in muted text

#### Scenario: Version visible regardless of layout state

- **WHEN** the inspector is collapsed, expanded, the bottom panel is open, or any tab is active
- **THEN** the version string remains visible in the status bar

#### Scenario: Version reflects the running binary, not config files

- **WHEN** the running app is v0.1.5 but `package.json` on disk says `0.1.6` (mid-release race)
- **THEN** the status bar still shows `v0.1.5` because it reads from the Tauri runtime, not from package.json

### Requirement: Status bar surfaces pending update state

When the auto-updater has downloaded a new version that will apply on next quit, the status bar version display MUST visually indicate the pending update by appending the target version in the accent color (e.g. `v0.1.5 → v0.1.7`). A tooltip on hover MUST explain "Restart Argus Beta to apply v0.1.7". When no update is pending, only the current version is shown.

#### Scenario: No pending update shows current version only

- **WHEN** no update has been downloaded yet
- **THEN** the status bar shows `v0.1.5` with no arrow or second version

#### Scenario: Pending update shows arrow and target version

- **WHEN** the updater has finished downloading v0.1.7 and is waiting for quit to apply
- **THEN** the status bar shows `v0.1.5 → v0.1.7` with the second version in the accent color

#### Scenario: Tooltip explains pending state

- **WHEN** the user hovers over `v0.1.5 → v0.1.7`
- **THEN** a tooltip appears with text "Restart Argus Beta to apply v0.1.7"

#### Scenario: After restart, pending indicator clears

- **WHEN** the user quits, the update applies, and the app relaunches as v0.1.7
- **THEN** the status bar shows `v0.1.7` with no arrow until a newer version is detected

### Requirement: Version display offers an actions menu

Clicking the version string in the status bar MUST open a dropdown menu with the following actions, in this order: "Check for updates now" (forces an immediate updater check), "Skip this version" (only enabled and visible when an update is pending or available; persists skip per the app-updater capability), "Clear skipped version" (only enabled and visible when a skip is currently active), and "About Argus Beta" (opens an about modal showing version, identifier, build commit, and a link to the release notes URL on R2).

#### Scenario: Menu opens on click

- **WHEN** the user clicks the version string in the status bar
- **THEN** a dropdown menu appears anchored to that element

#### Scenario: Skip option only when relevant

- **WHEN** there is no pending or available update
- **THEN** the "Skip this version" item is hidden or disabled

#### Scenario: Force-check triggers an updater request

- **WHEN** the user clicks "Check for updates now"
- **THEN** the updater immediately performs a check (without waiting for the 4-hour interval) and the menu closes


### Requirement: Inactive tab content remains mounted

The center tab system SHALL keep every tab that has been activated at least once mounted in the DOM for the lifetime of the tab. Switching between tabs MUST change visibility only — it MUST NOT unmount or remount tab renderers. Tab renderers MAY rely on this guarantee to retain component state (data, scroll, selection, edit buffers) across activations without external persistence.

A tab that has been opened but never activated MAY be lazily mounted on first activation. Once mounted, it MUST remain mounted until the tab is closed.

Closing a tab MUST unmount its renderer immediately so that component state and any held resources are released.

Each tab renderer SHALL receive an `active: boolean` prop indicating whether it is the currently visible tab. Renderers that register window-level or document-level side-effects (keyboard listeners, focus handlers, document title updates) MUST gate those side-effects on `active === true` so that hidden tabs do not interfere with the active one.

#### Scenario: Inactive tab renderer is not unmounted

- **WHEN** the user activates tab A, then activates tab B
- **THEN** tab A's renderer is still mounted (its React component instance is preserved) and its DOM subtree is present but hidden
- **AND** tab A's internal state (such as fetched data, scroll position, and form input) is preserved

#### Scenario: Reactivating a tab does not remount it

- **WHEN** the user activates tab A, switches to tab B, then activates tab A again
- **THEN** tab A's renderer does NOT pass through an unmount/remount cycle
- **AND** any effect whose dependencies have not changed MUST NOT re-run

#### Scenario: First activation is lazy

- **WHEN** a tab is opened programmatically but the user has not yet activated it
- **THEN** the tab MAY be unmounted (no DOM, no component instance)
- **AND** when the user activates it for the first time, the renderer mounts and stays mounted thereafter

#### Scenario: Closing a tab releases its renderer

- **WHEN** the user closes tab A
- **THEN** tab A's renderer is unmounted on the next render
- **AND** any rows, edit buffers, or other in-memory state held by that renderer are eligible for garbage collection

#### Scenario: Hidden tab does not consume keyboard shortcuts

- **WHEN** two table-viewer tabs are open, tab A is active, and the user presses a per-tab keyboard shortcut (for example `Cmd+1`)
- **THEN** only tab A's handler responds
- **AND** tab B's window-level handler MUST NOT fire because `active === false` for tab B

### Requirement: Sidebar connection kind picker

The sidebar's "+" affordance in the "Connections" section SHALL open a small menu whose first item, "New connection", opens a **kind picker** rather than going directly to a kind-specific form. The kind picker MUST render one selectable card per supported connection kind, currently `postgres` and `dynamodb`, each card showing the kind's icon, its display name ("PostgreSQL" / "DynamoDB"), and a one-line description. Activating a card MUST open that kind's connection form (the Postgres form for `postgres`, the Dynamo form for `dynamodb`). The picker MUST be dismissable with `Escape` and via a Cancel affordance, in which case no form is opened.

Connection rows in the "Connections" section SHALL dispatch their icon and primary click handler by the row's `kind` value: `postgres` rows render the Postgres icon and use the Postgres connect/disconnect path; `dynamodb` rows render the Dynamo icon and use the Dynamo connect/disconnect path; rows with an unknown `kind` SHALL fall back to rendering the kind value as plain text (existing behavior) and SHALL have no primary-click handler.

#### Scenario: Plus button opens kind picker

- **WHEN** the user clicks the "+" button in the Connections section header and activates "New connection"
- **THEN** a kind picker dialog opens with at least one card per supported kind (`postgres`, `dynamodb`)

#### Scenario: Picking Postgres opens the Postgres form

- **WHEN** the kind picker is open and the user activates the PostgreSQL card
- **THEN** the Postgres connection form opens in "Form" view with empty fields
- **AND** the kind picker closes

#### Scenario: Picking DynamoDB opens the Dynamo form

- **WHEN** the kind picker is open and the user activates the DynamoDB card
- **THEN** the Dynamo connection form opens with empty fields
- **AND** the kind picker closes

#### Scenario: Escape cancels the kind picker

- **WHEN** the kind picker is open and the user presses Escape (or clicks Cancel)
- **THEN** the picker closes and no form opens

#### Scenario: Postgres row dispatches to Postgres handlers

- **WHEN** the sidebar renders a connection row with `kind: "postgres"`
- **THEN** the row renders the Postgres icon and clicking the inactive row invokes `postgres.connect(id)`

#### Scenario: Dynamo row dispatches to Dynamo handlers

- **WHEN** the sidebar renders a connection row with `kind: "dynamodb"`
- **THEN** the row renders the Dynamo icon and clicking the inactive row invokes `dynamo.connect(id)`

#### Scenario: Unknown kind falls back to plain text

- **WHEN** the sidebar renders a connection row whose `kind` is neither `postgres` nor `dynamodb`
- **THEN** the row renders the `kind` value as plain text in the icon slot and clicking the row has no effect

