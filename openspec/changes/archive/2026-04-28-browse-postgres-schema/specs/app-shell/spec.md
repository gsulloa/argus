## ADDED Requirements

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
