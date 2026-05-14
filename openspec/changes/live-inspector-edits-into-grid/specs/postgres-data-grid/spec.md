## MODIFIED Requirements

### Requirement: Inspector panel

The viewer SHALL render an inspector panel pinned to the right of the grid. When a row is selected, the inspector MUST list every column from the response's `columns` array as a field showing `column name (data_type) → value`. Columns whose value was returned as a `truncated`/`binary` envelope MUST display the preview plus the original byte length. Long text values in the inspector MUST be scrollable inside their field, not truncated. When no row is selected, the inspector MUST display a hint such as "Select a row to inspect". The inspector MUST be horizontally resizable by dragging its left edge; the width MUST persist under `pgInspectorWidth` (a single global setting, not per-table) with a sensible minimum (e.g. 280px).

When the viewer is in editable mode, the inspector MUST reflect the buffer's dirty state for the selected row: cells that have been edited in the buffer MUST display the dirty value (not the server value), with a visual marker indicating the field is dirty. Editing inside the inspector MUST be supported as an alternative to inline grid editing for non-PK columns; changes commit to the buffer the same way (no direct DB writes). PK columns of existing rows MUST remain read-only in the inspector. Truncated/binary cells MUST remain read-only in the inspector regardless of mode.

**Live commit semantics (single-row mode).** When the inspector is in single-row mode (effective selection of 0 or 1 row), every editable field MUST commit its current value to the edit buffer on every user-driven value change (the input's `onChange` / `change` event), not on blur. This applies to ALL field types: boolean select, enum select, numeric input, text input, and the long-text / JSON-or-JSONB textarea. As a consequence, when the user types or picks a value in any single-row inspector field, the corresponding grid cell MUST re-render with the dirty marker and the new display value before the user releases focus.

For the long-text / JSON textarea specifically: the buffer MUST receive the raw `text` value on every change. JSON strict-parse validation (`validateJsonInput`) MUST NOT block the commit during typing; it MUST run on blur ONLY for the purpose of setting the inline error / smart-quote warning UI. The authoritative JSON validation for save still happens at apply time (Cmd-S) per the existing `postgres-data-edit` rules — an invalid JSON value sitting in the buffer is accepted at the inspector level but rejected at flush.

For the numeric input: the same tolerant parsing currently used by the in-grid editor (`parseInputValue`) applies on every change — fully-parseable inputs coerce to `number`, partial inputs (e.g. `"-"`, `"3."`) remain as strings, and the empty string resolves to `null`.

**Bulk-edit mode is OUT OF SCOPE for live-commit semantics.** When the effective selection is 2 or more rows, the bulk inspector's Apply/Cancel gate from the `postgres-data-edit` capability ("Bulk-edit mode in the inspector when multiple rows are selected") remains in force. Fields stay in their local touched/pristine state until Apply is clicked. This requirement does NOT modify that behavior.

#### Scenario: Selecting a row populates the inspector

- **WHEN** the user clicks any row in the grid
- **THEN** the inspector lists every column with its data type and value
- **AND** the field for a `text` column with a 5KB value is scrollable (not visually truncated)

#### Scenario: Truncated values show preview and byte length

- **WHEN** a column was returned as `{ kind: "truncated", preview, byte_length }`
- **THEN** the inspector field shows the preview plus a label like `5.2 KB`

#### Scenario: Width persists across sessions

- **WHEN** the user resizes the inspector to 420px
- **THEN** the next time the user opens any table viewer in any future app session, the inspector renders at 420px

#### Scenario: Inspector reflects dirty cell

- **WHEN** the user edits a cell in the grid then selects that row
- **THEN** the inspector field for that column shows the dirty value (not the server value)
- **AND** the field has a visual dirty marker

#### Scenario: Inspector edit commits to buffer

- **WHEN** the user is on a writable connection, selects a row, and edits a non-PK field in the inspector
- **THEN** that change is reflected in the buffer (the corresponding grid cell renders with dirty highlight)
- **AND** no SQL is dispatched until the user runs `⌘S` (which applies the buffer directly via `postgres_apply_table_edits`)

#### Scenario: Typing in a single-row inspector text field updates the grid live

- **WHEN** the user selects a single row and types `hello` into a `text` column field in the inspector
- **THEN** after each keystroke (`h`, `he`, `hel`, `hell`, `hello`) the grid cell for that column re-renders with the dirty marker and the cumulative display value
- **AND** the user does NOT need to blur or tab out of the field for the grid to update
- **AND** the inspector's input retains focus and the cursor position throughout

#### Scenario: Typing in a single-row inspector JSON textarea updates the grid live

- **WHEN** the user selects a single row and types `{"a":1}` into a `jsonb` column field in the inspector
- **THEN** after each keystroke the grid cell shows the cumulative raw text as the dirty display value
- **AND** the inspector textarea does NOT render an inline JSON error during typing (the strict-parse check only runs on blur)
- **AND** if the user blurs the textarea with mid-typed text like `{"a":` (invalid JSON), the inspector renders its existing inline JSON error UI
- **AND** the buffer continues to hold the invalid raw text; Cmd-S would surface a strict-parse error per the existing apply-time validation

#### Scenario: Numeric input in the inspector updates the grid per keystroke with tolerant parsing

- **WHEN** the user selects a single row and types `3.14` into a `numeric` column field in the inspector
- **THEN** after typing `3` the grid cell shows `3` with the dirty marker
- **AND** after typing `3.` the grid cell shows `3.` (still a string in the buffer; tolerant parse)
- **AND** after typing `3.14` the grid cell shows `3.14` (a `number` in the buffer)
- **AND** clearing the field shows `NULL` in the grid cell with the dirty marker

#### Scenario: Reverting an inspector edit to the original value cleans up the buffer

- **WHEN** the user types `hello` then deletes the 5 characters so the inspector field again shows the server value
- **THEN** after the final keystroke the grid cell no longer renders the dirty marker
- **AND** the buffer no longer contains an entry for that cell (the reducer collapses an edit equal to the original)

#### Scenario: External buffer change re-syncs the inspector field

- **WHEN** the user has selected row 5, then opens the in-grid editor for the `name` cell of row 5 and types `world`
- **THEN** the inspector's `name` field updates to show `world` (the existing `lastSyncedValueRef` re-sync continues to work under per-keystroke commits)

#### Scenario: Bulk-edit mode still uses Apply/Cancel (out of scope for this requirement)

- **WHEN** the user selects 3+ eligible rows so the inspector enters bulk-edit mode
- **THEN** typing into a bulk field does NOT commit to the buffer per keystroke
- **AND** the grid does NOT show dirty markers on the affected rows until the user clicks `Apply to <N> rows`
- **AND** the bulk inspector's behavior follows the `postgres-data-edit` capability's "Bulk-edit mode in the inspector when multiple rows are selected" requirement unchanged
