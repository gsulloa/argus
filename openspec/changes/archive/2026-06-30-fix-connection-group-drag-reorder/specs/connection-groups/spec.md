## MODIFIED Requirements

### Requirement: Drag and drop reorders and re-parents connections

The connections section SHALL support drag-and-drop to (a) reorder a connection within its group, (b) move a connection between groups, (c) reorder groups themselves, and (d) drop a connection onto any group's header — including a group with zero member connections — to append it to that group. All connection drags MUST be detected by a single drag context that spans every group section and the ungrouped sentinel section, so that a draggable started in any section can target a droppable in any other section. Collision detection within that single context MUST be scoped by the type of the active draggable: while a **group** is being dragged, the drop target MUST resolve only among group rows (other group sortables), and connection rows, group-header append droppables, and the ungrouped header MUST NOT be eligible drop targets; while a **connection** is being dragged, group sortables MUST NOT be eligible drop targets so that connection rows, group-header append droppables, and the ungrouped header continue to win. Each completed drop MUST result in exactly one IPC call: either `connections.move` for connection drops, or `connection_groups.update` for group reorderings. Drag-and-drop MUST be keyboard-operable and MUST announce its result to assistive technology.

#### Scenario: Reorder within the same group

- **WHEN** the user drags a connection from position 2 to position 4 within the same group
- **THEN** exactly one `connections.move` call is made with the same `group_id` and a new `sort_order` between the destination's neighbors

#### Scenario: Move between groups

- **WHEN** the user drags a connection from group A to a position inside group B
- **THEN** exactly one `connections.move` call is made with `group_id` set to B and a `sort_order` between the destination's neighbors in B

#### Scenario: Move into ungrouped section

- **WHEN** the user drags a connection from a group into the "Ungrouped" section
- **THEN** exactly one `connections.move` call is made with `group_id: null` and a `sort_order` placing it at the drop position

#### Scenario: Move from ungrouped into an empty group

- **WHEN** an empty group "Production" exists and the user has at least one connection in the "Ungrouped" section
- **AND** the user drags one of those ungrouped connections onto the header of "Production"
- **THEN** exactly one `connections.move` call is made with `group_id` set to Production's id and a `sort_order` placing the connection at the (new) end of that group
- **AND** after the call resolves, the connection renders inside "Production" and no longer renders under "Ungrouped"

#### Scenario: Move into a non-empty group via header drop

- **WHEN** the user drags a connection from any section onto the header of another group that already contains members
- **THEN** the connection is appended at the end of the target group (after its existing members) via a single `connections.move` call

#### Scenario: Reorder a group

- **WHEN** the user drags a group from position 1 to position 3
- **THEN** exactly one `connection_groups.update` call is made with the new `sort_order`
- **AND** the order of the group's child connections is unchanged

#### Scenario: Reorder a group across intervening connection rows

- **WHEN** the source group and its destination position have one or more expanded groups, connection rows, or the ungrouped header rendered between them
- **AND** the user drags the source group's handle so the pointer passes over those connection rows and finally rests over the destination group's row
- **THEN** the drop resolves to the destination group (not to any connection row or header it passed over)
- **AND** exactly one `connection_groups.update` call is made placing the group at the destination position

#### Scenario: Group reorder ignores non-group drop targets

- **WHEN** the user begins dragging a group and releases the pointer over a connection row or the ungrouped header
- **THEN** no IPC call is made and the group's `sort_order` is unchanged

#### Scenario: Keyboard drag-and-drop

- **WHEN** the user focuses a connection row, activates drag with the keyboard, and uses arrow keys to move it to a new position
- **THEN** the same single IPC call is made on commit
- **AND** a screen reader announcement describes the new group and position
