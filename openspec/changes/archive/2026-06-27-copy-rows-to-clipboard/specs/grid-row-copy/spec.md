## ADDED Requirements

### Requirement: Copy selected row range as TSV with Cmd+C

In every editable data grid — Postgres, MySQL, and MSSQL — when a row range is selected (a non-null `selection` anchor/active) and **no** single cell is active, pressing ⌘C (macOS) or Ctrl+C (other platforms) SHALL copy every row in the selected range to the system clipboard as tab-separated values and prevent the default copy. The serialized text MUST place one row per line (rows joined by `\n`) with cells joined by a tab (`\t`), in column order, and MUST be produced by the shared row formatter (see "Row TSV formatting"). This behaviour MUST be consistent across all three editable grids.

#### Scenario: Copy a multi-row selection

- **WHEN** the user selects rows 2 through 4 (no single cell active) and presses ⌘C
- **THEN** the system clipboard contains three lines, one per row, each line being that row's cell values joined by tabs
- **AND** the browser default copy is prevented

#### Scenario: Copy a single selected row

- **WHEN** exactly one row is selected as a row range and the user presses ⌘C
- **THEN** the system clipboard contains that one row's cell values joined by tabs

#### Scenario: Postgres parity with MySQL/MSSQL

- **WHEN** the user selects a row range in the Postgres grid and presses ⌘C
- **THEN** rows are copied as TSV identically to the MySQL and MSSQL grids

### Requirement: Copied rows reflect pending edits

In all three editable grids, the cell values written for a copied row range MUST reflect pending in-buffer edits, using the same display-value resolution as single-cell copy. A cell with an uncommitted edit MUST be copied with its edited value, not its original server value. Cells without pending edits MUST be copied with their server value.

#### Scenario: Edited cell copies the edited value

- **WHEN** a row has an uncommitted edit changing a cell from `foo` to `bar`, the row is selected, and the user presses ⌘C
- **THEN** the copied TSV for that row contains `bar`, not `foo`

#### Scenario: Unedited cells copy server values

- **WHEN** a selected row has no pending edits and is copied
- **THEN** every cell in the copied line equals its server value as formatted for the clipboard

### Requirement: Row-copy and cell-copy are mutually exclusive

Row-range copy SHALL fire only when a row range is selected and no single cell is active; single-cell copy SHALL fire only when a cell is active. The two paths MUST NOT both produce clipboard content for one ⌘C press, and the active-cell path takes precedence.

#### Scenario: Active cell suppresses row copy

- **WHEN** a single cell is active (even if a prior row range existed) and the user presses ⌘C
- **THEN** only the active cell's value is copied and the row-range copy does not fire

#### Scenario: No selection copies nothing

- **WHEN** neither a single cell nor a row range is selected and the user presses ⌘C
- **THEN** the grid does not write row TSV to the clipboard

### Requirement: Row copy is not intercepted in edit mode

While a cell is in edit mode (an input/textarea/select has focus), ⌘C / Ctrl+C MUST NOT trigger row-range copy; the browser's native copy of the selected text inside the editor MUST apply.

#### Scenario: Native copy inside an open editor

- **WHEN** a cell is in edit mode, the user selects text in the editor, and presses ⌘C
- **THEN** the selected editor text is copied by the browser and no row TSV is written

### Requirement: Row TSV formatting

A single shared helper SHALL convert an array of rows (each an array of cell values) to tab-separated clipboard text, reusing the same per-cell value→string formatter used by single-cell copy. The mapping for each cell MUST be: SQL `NULL` → empty string; boolean → `true` / `false`; objects/arrays → their JSON serialization; binary/truncated envelopes → their preview text; all other values → their plain string form. Rows MUST be joined by `\n` and cells within a row by `\t`.

#### Scenario: Mixed values in one row

- **WHEN** a row's resolved cell values are `42`, `NULL`, the boolean `true`, and the object `{ "a": 1 }`
- **THEN** the formatted line is `42\t\ttrue\t{"a":1}`

#### Scenario: Multiple rows joined by newlines

- **WHEN** two rows are formatted together
- **THEN** the result is the two formatted lines joined by a single `\n`
