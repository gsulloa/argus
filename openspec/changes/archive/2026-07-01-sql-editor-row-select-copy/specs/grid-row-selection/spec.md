## ADDED Requirements

### Requirement: Select a whole row from the gutter in the ad-hoc SQL result grid

The read-only ad-hoc SQL result grid (`AdhocResultGrid`, used by the Postgres SQL editor) SHALL render a left row-number gutter and allow selecting a whole row from it, matching the editable data grids. A plain click on a gutter cell SHALL select that row as a single-row range (`selection.anchor === selection.active === rowIndex`) and clear any active single cell. Row-range selection and single-cell selection MUST remain mutually exclusive: selecting a row clears the active cell, and clicking a data cell clears the row range. The gutter MUST show a pointer cursor and a hover affordance so it reads as interactive. Row numbers are 1-based and MUST reflect the row's display position (after any client-side sort).

#### Scenario: Click a gutter cell selects that row

- **WHEN** the user clicks the gutter cell of a row in the ad-hoc SQL result grid (no modifier)
- **THEN** that row becomes a single-row selection and any active cell is cleared

#### Scenario: Clicking a data cell clears the row selection

- **WHEN** a row is selected via the gutter and the user then clicks a data cell
- **THEN** that cell becomes the active cell and the row-range selection is cleared

#### Scenario: Selecting a row then ⌘C copies the row

- **WHEN** the user clicks a row's gutter cell in the ad-hoc SQL result grid and presses ⌘C
- **THEN** that row's cells are written to the clipboard as one TSV line (via the row-range copy path)

### Requirement: Extend and drag row selection in the ad-hoc SQL result grid

In the ad-hoc SQL result grid, shift-clicking a gutter cell while a selection anchor exists SHALL extend the row range from the existing anchor to the shift-clicked row (keeping the anchor, setting the active index) and clear any active single cell. Dragging over the gutter SHALL update the active index continuously (with auto-scroll near the viewport edges), using the same pixel-to-row-index resolution as the editable grid.

#### Scenario: Shift-click extends the range

- **WHEN** row 2 is selected and the user shift-clicks the gutter of row 5
- **THEN** rows 2 through 5 are selected as a range

#### Scenario: Drag over the gutter selects a range

- **WHEN** the user presses on the gutter of row 3 and drags down to row 7
- **THEN** rows 3 through 7 are selected as a range

### Requirement: Gutter selection keeps keyboard copy working in the ad-hoc SQL result grid

In the ad-hoc SQL result grid, selecting a row from the gutter SHALL leave keyboard focus on the grid so that ⌘C / Ctrl+C copies the selection without an extra click.

#### Scenario: Copy immediately after gutter selection

- **WHEN** the user clicks a gutter cell in the ad-hoc SQL result grid and then presses ⌘C without clicking elsewhere
- **THEN** the selected row is copied to the clipboard
