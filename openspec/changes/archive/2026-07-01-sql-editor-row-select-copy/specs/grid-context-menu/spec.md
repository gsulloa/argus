## MODIFIED Requirements

### Requirement: Right-click opens a row/cell context menu

Every row-range-capable editable data grid — Postgres, MySQL, and MSSQL — SHALL open a context menu when the user right-clicks (or uses the platform context-menu gesture) on a data row or cell. The menu MUST present the common row/cell actions in a single place: **Copy cell**, **Copy row(s)**, **Edit cell**, and **Delete row(s)** (or **Restore row(s)** when the target is already marked for deletion). The menu MUST be styled per `DESIGN.md` and dismiss on selection of an item, on Escape, or on a click outside it.

The read-only ad-hoc SQL result grid (`AdhocResultGrid`, used by the Postgres SQL editor) SHALL also open a context menu on right-click, but as a **Copy-only** variant (see "Read-only Copy-only context menu"). Athena and CloudWatch result tables remain out of scope and MUST NOT show a grid context menu.

#### Scenario: Right-click a cell opens the menu

- **WHEN** the user right-clicks a data cell in a Postgres, MySQL, or MSSQL data grid
- **THEN** a context menu appears anchored at the pointer
- **AND** it lists Copy cell, Copy row(s), Edit cell, and Delete row(s) / Restore row(s)

#### Scenario: Menu dismisses

- **WHEN** the context menu is open and the user presses Escape or clicks outside it
- **THEN** the menu closes without performing any action

#### Scenario: Right-click in the ad-hoc SQL result grid opens a Copy-only menu

- **WHEN** the user right-clicks a row or cell in the ad-hoc SQL result grid
- **THEN** a context menu appears listing only Copy cell and Copy row(s)
- **AND** it shows no Edit cell or Delete/Restore row(s) items

#### Scenario: Right-click is not added to the remaining read-only result tables

- **WHEN** the user right-clicks in an Athena or CloudWatch result table
- **THEN** no grid context menu is shown (this change does not cover those tables)

## ADDED Requirements

### Requirement: Read-only Copy-only context menu

The ad-hoc SQL result grid SHALL present a context menu containing exactly two items — **Copy cell** and **Copy row(s)** — with no Edit or Delete/Restore items, because ad-hoc query results are immutable. The menu MUST be styled per `DESIGN.md` and dismiss on item selection, Escape, or outside click, identical to the editable grids' menu.

Each item SHALL dispatch the same logic as the corresponding keyboard gesture, with no divergent code path:
- **Copy cell** copies the target cell's value using the shared cell value→string formatter (identical to ⌘C single-cell copy).
- **Copy row(s)** copies the target row, or all selected rows when the right-clicked row is inside an active multi-row selection, as TSV using the shared row formatter (identical to ⌘C row-range copy).

Menu target resolution MUST match the editable grids: right-clicking a row outside the current selection retargets to that single row; right-clicking inside an active multi-row selection keeps the whole selection as the target. The "(s)" labelling of Copy row(s) MUST reflect whether one or multiple rows are targeted.

#### Scenario: Copy cell matches Cmd+C output

- **WHEN** the user chooses "Copy cell" on a cell containing `42` in the ad-hoc SQL result grid
- **THEN** the system clipboard contains exactly `42`, identical to pressing ⌘C on that cell

#### Scenario: Copy row(s) matches Cmd+C row-range output

- **WHEN** rows 2–4 are selected and the user chooses "Copy rows" from the menu
- **THEN** the clipboard contains those three rows as TSV, identical to pressing ⌘C on the selection

#### Scenario: Right-click outside selection retargets to a single row

- **WHEN** rows 2–5 are selected and the user right-clicks row 9 in the ad-hoc SQL result grid
- **THEN** row 9 becomes the single action target and the menu item reads "Copy row"
- **AND** Copy row copies only row 9

#### Scenario: Right-click inside selection keeps it

- **WHEN** rows 2–5 are selected and the user right-clicks within row 3
- **THEN** the selection stays rows 2–5 and the menu item reads "Copy rows"
- **AND** Copy rows copies all of rows 2–5
