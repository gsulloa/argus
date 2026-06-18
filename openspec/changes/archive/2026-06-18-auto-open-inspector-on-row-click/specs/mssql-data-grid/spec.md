## MODIFIED Requirements

### Requirement: Inspector panel

The viewer SHALL render an inspector panel pinned to the right of the grid. The panel's visibility MUST be toggleable via an `Inspector` button in the viewer toolbar; it defaults to visible. When a row is selected, the inspector MUST list every column from the response's `columns` array as a field showing `column name (data_type) → value`. Columns whose value was returned with `{ truncated: true, size }` MUST display the preview plus the original byte count (formatted as `KB`/`MB`). Long text values in the inspector MUST be scrollable inside their field, not truncated. When the column type is `JSON` (SQL Server 2025+) or `XML`, the inspector MUST render the parsed value as a collapsible tree (object/array nodes expandable for JSON; element/attribute nodes expandable for XML). For binary types (`BINARY` / `VARBINARY` / `IMAGE` / `ROWVERSION`), the inspector MUST display the encoding as `base64` next to the field label. When no row is selected, the inspector MUST display a hint such as "Select a row to inspect". The inspector MUST be horizontally resizable by dragging its left edge; the width MUST persist under `msInspectorWidth` (a single global setting, not per-table) with a sensible minimum (e.g. 280px).

When the inspector panel is hidden, selecting a row in the grid MUST automatically reveal the panel and show the selected row. The auto-reveal MUST fire only on row/cell selection gestures (plain click and shift-click range extension); it MUST NOT fire on column header sort clicks, column resize, scroll, or toolbar actions. The auto-reveal MUST NOT change the selection range and MUST NOT interrupt an in-progress inline edit. Once revealed, the user MAY hide the inspector again via the toolbar toggle, and the next row selection MUST re-reveal it.

When the viewer is in editable mode, the inspector MUST reflect the buffer's dirty state for the selected row: cells that have been edited in the buffer MUST display the dirty value (not the server value), with a visual marker indicating the field is dirty. Editing inside the inspector MUST be supported as an alternative to inline grid editing for non-PK columns; changes commit to the buffer the same way (no direct DB writes). PK columns of existing rows MUST remain read-only in the inspector. Truncated/binary cells MUST remain read-only in the inspector regardless of mode. Cells of type `GEOMETRY`, `GEOGRAPHY`, `HIERARCHYID`, and `SQL_VARIANT` MUST be read-only in the inspector (v1 does not support writes for those types).

#### Scenario: Selecting a row populates the inspector

- **WHEN** the user clicks any row in the grid
- **THEN** the inspector lists every column with its data type and value

#### Scenario: Clicking a row reveals a hidden inspector

- **WHEN** the inspector panel is hidden and the user clicks a row in the grid
- **THEN** the inspector panel becomes visible
- **AND** it shows the clicked row's columns and values

#### Scenario: Clicking another row updates the open inspector without closing it

- **WHEN** the inspector panel is already visible and the user clicks a different row
- **THEN** the inspector updates to the newly clicked row
- **AND** the panel stays visible

#### Scenario: Header sort does not reveal a hidden inspector

- **WHEN** the inspector panel is hidden and the user clicks a column header to sort, drags a column to resize it, scrolls the grid, or activates a toolbar action
- **THEN** the inspector panel stays hidden

#### Scenario: Shift-click multi-row selection reveals the inspector in range mode

- **WHEN** the inspector panel is hidden and the user shift-clicks to extend a row range
- **THEN** the inspector panel becomes visible
- **AND** it reflects the multi-row selection

#### Scenario: Truncated values show preview and byte length

- **WHEN** a column was returned as `{ truncated: true, size: 5300, preview: "..." }`
- **THEN** the inspector field shows the preview plus a label like `5.2 KB`

#### Scenario: JSON column renders as expandable tree

- **WHEN** a `payload JSON` column (SQL Server 2025+) has a nested object value
- **THEN** the inspector renders the JSON as a collapsible tree (objects and arrays expandable)
- **AND** primitive leaves are shown inline

#### Scenario: XML column renders as expandable tree

- **WHEN** a `body XML` column has a nested element value
- **THEN** the inspector renders the XML as a collapsible tree

#### Scenario: Binary column shows base64 encoding label

- **WHEN** a `data VARBINARY` column has a base64-encoded value
- **THEN** the inspector field carries a `base64` marker
- **AND** the field is read-only

#### Scenario: GEOMETRY column is read-only

- **WHEN** the inspector renders a `GEOMETRY` cell
- **THEN** the field is read-only regardless of the viewer's editable mode

#### Scenario: Width persists across sessions

- **WHEN** the user resizes the inspector to 420px
- **THEN** the next time the user opens any MS SQL Server table viewer in any future app session, the inspector renders at 420px

#### Scenario: Inspector reflects dirty cell

- **WHEN** the user edits a cell in the grid then selects that row
- **THEN** the inspector field for that column shows the dirty value (not the server value)
- **AND** the field has a visual dirty marker
