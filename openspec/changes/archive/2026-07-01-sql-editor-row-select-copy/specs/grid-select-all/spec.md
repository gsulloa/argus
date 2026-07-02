## ADDED Requirements

### Requirement: Select all rows with Cmd+A in the ad-hoc SQL result grid

When the read-only ad-hoc SQL result grid (`AdhocResultGrid`, used by the Postgres SQL editor) holds keyboard focus, a selection is already active (either a single active cell or a row range), and the focus is NOT inside a text input, pressing `Cmd+A` (macOS) or `Ctrl+A` (other platforms) SHALL select every row currently loaded in the grid and SHALL prevent the browser's default select-all behavior.

Selecting all rows MUST set the row-range selection to `{ anchor: 0, active: rows.length - 1 }`. Because single-cell selection and row-range selection are mutually exclusive, the active cell (if any) MUST be cleared as part of selecting all rows.

`Cmd+A` / `Ctrl+A` MUST be inert when there is no active grid selection (neither a row range nor a single active cell is set) or the grid holds no loaded rows: the handler MUST NOT call `preventDefault` and MUST leave native select-all intact.

#### Scenario: Cmd+A extends a single-row selection to all rows

- **WHEN** the ad-hoc SQL result grid has focus, exactly one row is selected, and the user presses `Cmd+A`
- **THEN** the selection becomes `{ anchor: 0, active: rows.length - 1 }`
- **AND** every loaded row renders as selected
- **AND** the browser default select-all is prevented

#### Scenario: Cmd+A from an active cell selects all rows

- **WHEN** the ad-hoc SQL result grid has focus, a single cell is the active cell (no row range), and the user presses `Cmd+A`
- **THEN** the active cell is cleared
- **AND** the selection becomes `{ anchor: 0, active: rows.length - 1 }`
- **AND** the browser default select-all is prevented

#### Scenario: Cmd+A is inert without an active grid selection

- **WHEN** neither a row range nor a single active cell is set in the ad-hoc SQL result grid and the user presses `Cmd+A`
- **THEN** the grid does not call `preventDefault` and native select-all is left intact
