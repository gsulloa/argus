## MODIFIED Requirements

### Requirement: Resize handle interaction

Every grid header cell whose column is resizable SHALL expose a draggable hit area along its right edge that is 6px wide (3px inside the cell, 3px outside). The hit area MUST:

- Set `cursor: col-resize` on hover and during drag.
- Render a visible 1px vertical accent line on hover and during drag, using the `--accent` token at 50% opacity with `transition: opacity var(--duration-instant)`. The handle MUST NOT be visible in the idle state.
- Use HTML pointer events with `setPointerCapture` so move events route only to the captured target. The grid MUST listen to `pointermove`, `pointerup`, and `pointercancel` to update and finalize the width.
- During an active drag, the document body MUST receive `user-select: none` and `cursor: col-resize` so cross-cell drag does not flicker the cursor; both MUST be cleared on pointer up/cancel.
- Clamp the resulting width to `[56, 800]` pixels before applying.
- On `dblclick` over the hit area, remove the column's entry from the record (reset to type-derived base width).
- **Isolate its events from the enclosing header cell.** The hit area is rendered inside a header cell that may itself be clickable (in every SQL grid, clicking the header cycles the column's sort). Neither the `click` the browser synthesises after `pointerup` nor the `dblclick` used for width reset MUST reach the header cell or any other ancestor. This isolation MUST hold for a click on the hit area whether or not the pointer moved, and MUST be implemented once in the shared resize-handle component rather than per-grid, so every consuming grid (Postgres table viewer, Postgres ad-hoc result grid, MySQL, MSSQL, DynamoDB) inherits it.

Columns flagged as `nonResizable` MUST NOT render a hit area (e.g. DynamoDB's `More…` column).

#### Scenario: Hover reveals handle

- **WHEN** the pointer enters the right-edge hit area of a resizable column header
- **THEN** a 1px vertical line appears at 50% accent opacity within `--duration-instant`

#### Scenario: Drag updates width live

- **WHEN** the user presses pointer down on the handle of a 180px column and moves the pointer 40px to the right before releasing
- **THEN** the column's rendered width transitions to 220px during the drag (live feedback)
- **AND** on pointer up, the override `{ <column>: 220 }` is committed to the record and scheduled for persistence

#### Scenario: Width clamps at the minimum

- **WHEN** the user drags the handle so the computed width would be 30px
- **THEN** the column width is set to 56px instead

#### Scenario: Width clamps at the maximum

- **WHEN** the user drags the handle so the computed width would be 1200px
- **THEN** the column width is set to 800px instead

#### Scenario: Double-click resets to type default

- **WHEN** the user has set `status` to 300px and then double-clicks the handle on the `status` header
- **THEN** the override for `status` is removed from the record
- **AND** `status` re-renders at its type-derived base width

#### Scenario: Non-resizable column shows no handle

- **WHEN** the DynamoDB Tabla view renders the `More…` column
- **THEN** no resize hit area is rendered on its right edge
- **AND** hovering its right edge does not reveal an accent line

#### Scenario: Releasing a resize drag does not sort the column

- **WHEN** the user drags the resize handle of a sortable column header to a new width and releases the pointer button over the handle
- **THEN** the column is resized
- **AND** the grid's sort order is unchanged — the header's sort action is not invoked and no re-query is issued

#### Scenario: A click on the handle without dragging does not sort

- **WHEN** the user presses and releases the pointer on the resize hit area without moving it
- **THEN** the grid's sort order is unchanged

#### Scenario: Double-click reset does not sort

- **WHEN** the user double-clicks the resize handle of a sortable column header to reset its width
- **THEN** the column's width override is removed
- **AND** the grid's sort order is unchanged (neither of the two constituent clicks reaches the header)

#### Scenario: Clicking the header outside the handle still sorts

- **WHEN** the user clicks the header cell of a sortable column anywhere outside the 6px resize hit area
- **THEN** the column's sort cycles as before (including shift-click multi-sort where the grid supports it)
