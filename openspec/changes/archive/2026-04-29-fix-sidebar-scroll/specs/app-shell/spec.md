## MODIFIED Requirements

### Requirement: Sidebar sections may host hierarchical subtrees

The sidebar SHALL allow each section (for example "Connections", or future module-specific sections) to host a `SidebarTree` underneath one or more of its rows. The sidebar MUST provide a single vertical scroll context that contains every section and every embedded `SidebarTree` below the brand header; embedded trees MUST grow to their natural content height and contribute to that shared scroll rather than scrolling independently. Embedded trees MUST respect the persisted sidebar width.

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
