# grid-cell-copy Specification

## Purpose

Provide a single, uniform way to select one cell in any data grid (Postgres, MySQL, MSSQL, Athena — editable and read-only) and copy its value to the system clipboard with ⌘C/Ctrl+C. This layers single-cell selection and copy semantics on top of the existing per-engine grids without disturbing row-range selection, row-range TSV copy, or inline editing.

## Requirements

### Requirement: Single-cell selection

Every data grid — Postgres, MySQL, MSSQL, and Athena, in both editable and read-only variants — SHALL support selecting a single cell. A single click on a cell MUST mark it as the **active cell**, identified by its `{ row, col }` position, and MUST render a visible focus ring on that cell (per `DESIGN.md`). Single-cell selection MUST be distinct from the existing row-range selection: marking an active cell MUST clear any active row-range selection, and starting a row-range selection MUST clear the active cell. The active cell MUST be cleared on Escape and when the grid's rows change (sort, filter, page change, refresh).

#### Scenario: Click marks the active cell

- **WHEN** the user single-clicks a cell in any grid
- **THEN** that cell becomes the active cell and shows a focus ring
- **AND** any previous active cell or row-range selection is cleared

#### Scenario: Escape clears the active cell

- **WHEN** a cell is active and the user presses Escape
- **THEN** the active cell is cleared and no focus ring is shown

#### Scenario: Active cell clears on data change

- **WHEN** a cell is active and the user sorts, filters, pages, or refreshes the grid
- **THEN** the active cell is cleared

### Requirement: Copy active cell value with Cmd+C

When a single cell is active and the grid (not a text input) holds focus, pressing ⌘C (macOS) or Ctrl+C (other platforms) SHALL copy that cell's value to the system clipboard as plain text and prevent the default copy. The copied text MUST be produced by the shared value→string formatter (see "Cell value formatting"). This behaviour MUST work identically in editable grids (Postgres/MySQL/MSSQL) and read-only grids (`AdhocResultGrid`, Athena `SimpleTable`).

#### Scenario: Copy a single id cell

- **WHEN** the user clicks a cell containing the value `42` and presses ⌘C
- **THEN** the system clipboard contains exactly `42`
- **AND** the browser default copy is prevented

#### Scenario: Copy works in a read-only grid

- **WHEN** the user clicks a cell in an Athena result table or an ad-hoc result grid and presses ⌘C
- **THEN** the system clipboard contains that cell's formatted value

#### Scenario: Copy a null cell yields empty string

- **WHEN** the user copies a cell whose value is SQL `NULL`
- **THEN** the system clipboard contains an empty string

### Requirement: Cell-copy precedence over row-range copy

Where a grid already supports row-range copy (multi-row TSV), the copy handler SHALL copy the **single active cell's value** when a cell is active, and SHALL fall back to the existing row-range TSV copy when a row range — but no single cell — is selected. The two selection modes MUST be mutually exclusive so the copy target is never ambiguous.

#### Scenario: Active cell wins over no row selection

- **WHEN** a single cell is active and no row range is selected, and the user presses ⌘C
- **THEN** only that cell's value is copied (not the whole row)

#### Scenario: Row-range copy still works

- **WHEN** a multi-row range is selected and no single cell is active, and the user presses ⌘C
- **THEN** the existing TSV row-range copy is produced unchanged

### Requirement: Copy from within edit mode is not intercepted

While a cell is in edit mode (an input/textarea/select has focus), ⌘C / Ctrl+C MUST NOT be intercepted by the grid; the browser's native copy of the selected text inside the editor MUST apply. Double-click MUST continue to enter edit mode on editable cells; it MUST NOT be repurposed in a way that prevents copy.

#### Scenario: Native copy inside an open editor

- **WHEN** a cell is in edit mode, the user selects text in the input, and presses ⌘C
- **THEN** the selected input text is copied by the browser
- **AND** the grid does not override it with the cell value

### Requirement: Cell value formatting

A single shared helper SHALL convert a cell value to its clipboard string representation, used by both cell copy and existing row-range TSV copy across all engines. The mapping MUST be: SQL `NULL` → empty string; boolean → `true` / `false`; objects/arrays → their JSON serialization; all other values → their plain string form. Binary/truncated value envelopes MUST copy their human-readable preview text.

#### Scenario: Boolean formatting

- **WHEN** a cell value is the boolean `true`
- **THEN** the formatted clipboard text is `true`

#### Scenario: Object formatting

- **WHEN** a cell value is the object `{ "a": 1 }`
- **THEN** the formatted clipboard text is `{"a":1}`
