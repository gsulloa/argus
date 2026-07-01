# grid-row-selection Specification

## Purpose
TBD - created by archiving change fix-grid-row-copy-clipboard. Update Purpose after archive.
## Requirements
### Requirement: Select a whole row from the row-number gutter

Every editable data grid — Postgres, MySQL, and MSSQL — SHALL render a left row-number gutter and allow selecting a whole row from it. A plain click on a gutter cell SHALL select that row as a single-row range (`selection.anchor === selection.active === rowIndex`) and clear any active single cell. The gutter MUST show a pointer cursor and a hover affordance so it reads as interactive. Row numbers are 1-based and MUST reflect the row's display position.

#### Scenario: Click a gutter cell selects that row

- **WHEN** the user clicks the gutter cell of a row (no modifier)
- **THEN** that row becomes a single-row selection and any active cell is cleared

#### Scenario: Selecting a row then ⌘C copies the row

- **WHEN** the user clicks a row's gutter cell and presses ⌘C
- **THEN** that row's cells are written to the clipboard as one TSV line (via the row-range copy path)

### Requirement: Extend a row selection with shift-click

In every editable data grid, shift-clicking a gutter cell while a selection anchor exists SHALL extend the row range from the existing anchor to the shift-clicked row (keeping the anchor, setting the active index), and clear any active single cell.

#### Scenario: Shift-click extends the range

- **WHEN** row 2 is selected and the user shift-clicks the gutter of row 5
- **THEN** rows 2 through 5 are selected as a range

### Requirement: Gutter selection keeps keyboard copy working

In every editable data grid, selecting a row from the gutter SHALL leave keyboard focus on the grid so that ⌘C / Ctrl+C copies the selection without an extra click.

#### Scenario: Copy immediately after gutter selection

- **WHEN** the user clicks a gutter cell and then presses ⌘C without clicking elsewhere
- **THEN** the selected row is copied to the clipboard

