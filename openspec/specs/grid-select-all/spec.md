# grid-select-all Specification

## Purpose

Provide a uniform Cmd+A / Ctrl+A "select all rows" gesture for the row-range-capable data grids (Postgres, MySQL, MSSQL). It extends an existing grid selection to every loaded row without disturbing inline editing or the browser's native select-all in text inputs, and stays inert when the grid has no active selection.

## Requirements

### Requirement: Select all rows with Cmd+A

When a data grid that supports row-range selection — Postgres, MySQL, and MSSQL — holds keyboard focus, a selection is already active (either a single active cell or a row range), and the focus is NOT inside an inline cell editor or other text input, pressing `Cmd+A` (macOS) or `Ctrl+A` (other platforms) SHALL select every row currently loaded in the grid and SHALL prevent the browser's default select-all behavior.

Selecting all rows MUST set the row-range selection to `{ anchor: 0, active: <lastRowIndex> }`, where `<lastRowIndex>` is the index of the last row currently loaded (`rows.length - 1`). Because single-cell selection and row-range selection are mutually exclusive, the active cell (if any) MUST be cleared as part of selecting all rows.

#### Scenario: Cmd+A extends a single-row selection to all rows

- **WHEN** the grid has focus, exactly one row (e.g. row 5) is selected, and the user presses `Cmd+A`
- **THEN** the selection becomes `{ anchor: 0, active: rows.length - 1 }`
- **AND** every loaded row renders as selected
- **AND** the browser default select-all is prevented

#### Scenario: Cmd+A from an active cell selects all rows

- **WHEN** the grid has focus, a single cell is the active cell (no row range), and the user presses `Cmd+A`
- **THEN** the active cell is cleared
- **AND** the selection becomes `{ anchor: 0, active: rows.length - 1 }`
- **AND** the browser default select-all is prevented

#### Scenario: Cmd+A while all rows already selected is idempotent

- **WHEN** all rows are already selected and the user presses `Cmd+A` again
- **THEN** the selection remains `{ anchor: 0, active: rows.length - 1 }`
- **AND** the browser default select-all is prevented

### Requirement: Cmd+A is inert without an active grid selection

`Cmd+A` / `Ctrl+A` SHALL NOT be intercepted by the grid when there is no active grid selection. Specifically, when neither a row range nor a single active cell is set, OR the grid currently holds no loaded rows, the handler MUST NOT call `preventDefault` and MUST leave the browser's native select-all behavior intact.

#### Scenario: No selection lets native select-all through

- **WHEN** the grid has focus but no cell and no row range is selected, and the user presses `Cmd+A`
- **THEN** the grid does not change its selection
- **AND** the browser's default select-all is NOT prevented

#### Scenario: Empty grid does not capture Cmd+A

- **WHEN** the grid is focused but has zero loaded rows, and the user presses `Cmd+A`
- **THEN** no selection is created
- **AND** the browser's default select-all is NOT prevented

### Requirement: Cmd+A is not intercepted inside an editor

While a cell is in edit mode or the keyboard focus is inside an `<input>`, `<textarea>`, `<select>`, or contentEditable element, `Cmd+A` / `Ctrl+A` MUST NOT be intercepted by the grid; the browser's native select-all of the text inside that editor MUST apply unchanged.

#### Scenario: Native select-all inside an open cell editor

- **WHEN** a cell is in edit mode, the user has focus inside its input, and presses `Cmd+A`
- **THEN** the text inside the editor is selected by the browser
- **AND** the grid does not override it by selecting all rows
