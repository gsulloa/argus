# grid-context-menu Specification

## Purpose

Provide a uniform right-click context menu on the row-range-capable editable data grids (Postgres, MySQL, MSSQL) that surfaces the common row/cell actions — Copy cell, Copy row(s), Edit cell, and Delete/Restore row(s) — in one discoverable place. The menu dispatches the same logic as the existing keyboard shortcuts (no divergent code paths) and disables inapplicable actions with an explanatory tooltip for read-only / no-primary-key states.

## Requirements

### Requirement: Right-click opens a row/cell context menu

Every row-range-capable editable data grid — Postgres, MySQL, and MSSQL — SHALL open a context menu when the user right-clicks (or uses the platform context-menu gesture) on a data row or cell. The menu MUST present the common row/cell actions in a single place: **Copy cell**, **Copy row(s)**, **Edit cell**, and **Delete row(s)** (or **Restore row(s)** when the target is already marked for deletion). The menu MUST be styled per `DESIGN.md` and dismiss on selection of an item, on Escape, or on a click outside it.

#### Scenario: Right-click a cell opens the menu

- **WHEN** the user right-clicks a data cell in a Postgres, MySQL, or MSSQL data grid
- **THEN** a context menu appears anchored at the pointer
- **AND** it lists Copy cell, Copy row(s), Edit cell, and Delete row(s) / Restore row(s)

#### Scenario: Menu dismisses

- **WHEN** the context menu is open and the user presses Escape or clicks outside it
- **THEN** the menu closes without performing any action

#### Scenario: Right-click is not added to read-only result grids

- **WHEN** the user right-clicks in a read-only result grid (ad-hoc SQL results, Athena/CloudWatch result tables)
- **THEN** no grid context menu is shown (this change does not cover those grids)

### Requirement: Menu actions reuse existing behaviour

Each context-menu item SHALL dispatch exactly the same logic as the corresponding existing gesture, with no divergent code path:

- **Copy cell** copies the target cell's value to the system clipboard using the shared cell value→string formatter (identical to ⌘C single-cell copy).
- **Copy row(s)** copies the target row, or all selected rows when a multi-row range is active, to the clipboard as TSV using the same shared value formatter per cell.
- **Edit cell** enters inline edit mode on the target cell (identical to double-click / Enter), and is suppressed under the same conditions inline editing is (e.g. bulk-edit mode).
- **Delete row(s)** / **Restore row(s)** toggles the delete mark on the target row, or on all selected rows when a multi-row range is active, via the existing bulk delete-toggle buffer action (identical to Backspace / Delete).

#### Scenario: Copy cell matches Cmd+C output

- **WHEN** the user chooses "Copy cell" on a cell containing `42`
- **THEN** the system clipboard contains exactly `42`, identical to pressing ⌘C on that cell

#### Scenario: Delete row matches Backspace

- **WHEN** the user chooses "Delete row(s)" on a server row with a primary key
- **THEN** that row is marked for deletion in the edit buffer, identical to selecting it and pressing Backspace
- **AND** the menu item reads "Restore row(s)" the next time it is opened on that row

#### Scenario: Edit cell matches double-click

- **WHEN** the user chooses "Edit cell" on an editable cell
- **THEN** that cell enters inline edit mode, identical to double-clicking it

### Requirement: Menu target resolution

The action target SHALL be determined by where the user right-clicks relative to the current selection:

- Right-clicking a row that is **outside** the current selection MUST retarget: the right-clicked cell becomes the active cell and its row becomes the single action target, replacing any prior selection.
- Right-clicking **inside** an existing multi-row selection MUST keep that selection as the target, so row-scoped actions (Copy row(s), Delete row(s)) apply to all selected rows.
- The "(s)" labelling of Copy row(s) and Delete/Restore row(s) MUST reflect whether one row or multiple rows are targeted.

#### Scenario: Right-click outside selection retargets

- **WHEN** rows 2–5 are selected and the user right-clicks row 9
- **THEN** row 9 becomes the single action target (its cell becomes the active cell)
- **AND** Copy row / Delete row act only on row 9

#### Scenario: Right-click inside selection keeps it

- **WHEN** rows 2–5 are selected and the user right-clicks within row 3
- **THEN** the selection stays rows 2–5
- **AND** Copy rows / Delete rows act on all of rows 2–5

### Requirement: Inapplicable actions are disabled with a tooltip

Actions that cannot apply given the grid's read-only / no-primary-key state SHALL be shown but **disabled**, with a tooltip explaining why, rather than hidden:

- When the connection/relation is **read-only**, Edit cell and Delete/Restore row(s) MUST be disabled with an explanatory tooltip; Copy cell and Copy row(s) MUST remain enabled.
- When the relation has **no primary key**, Delete row(s) for server rows MUST be disabled with an explanatory tooltip (server rows cannot be deleted without a PK); inserted (unsaved) rows MUST still be removable.
- When the target cell is not editable (e.g. a primary-key column of an existing row, a binary/truncated value, or a no-PK relation), Edit cell MUST be disabled with an explanatory tooltip.
- Copy cell MUST always remain enabled.

#### Scenario: Read-only grid disables mutating actions

- **WHEN** the user right-clicks in a read-only data grid
- **THEN** Edit cell and Delete row(s) are disabled and show a tooltip explaining the grid is read-only
- **AND** Copy cell and Copy row(s) remain enabled

#### Scenario: No-PK relation disables server-row delete

- **WHEN** the relation has no primary key and the user right-clicks a server row
- **THEN** Delete row(s) is disabled with a tooltip explaining a primary key is required

#### Scenario: Non-editable cell disables Edit

- **WHEN** the user right-clicks a primary-key cell of an existing row
- **THEN** Edit cell is disabled with a tooltip explaining the cell cannot be edited
