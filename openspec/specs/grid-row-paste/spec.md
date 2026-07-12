# grid-row-paste Specification

## Purpose
TBD - created by archiving change duplicate-rows-copy-paste. Update Purpose after archive.
## Requirements
### Requirement: Paste TSV clipboard content as pending insert rows with Cmd+V

In every editable data grid — Postgres, MySQL, and MSSQL — when a row range is selected (a non-null `selection` anchor/active) and **no** single cell is active, pressing ⌘V (macOS) or Ctrl+V (other platforms) SHALL read the system clipboard, parse it as tab-separated values, and append one new **pending insert row** per non-empty clipboard line to the grid. The paste MUST be triggered from the grid's own keyboard handler (the same handler that performs row-range copy) and MUST read the clipboard programmatically (`navigator.clipboard.readText()`), not rely on the browser's native `paste` clipboard event. Each appended row MUST be the same kind of pending insert row the grid's existing "add row" affordance creates, so it participates in the normal unsaved-changes and Save flow. This behaviour MUST be consistent across all three editable grids.

#### Scenario: Paste a multi-line clipboard creates multiple pending rows

- **WHEN** the clipboard holds three tab-separated lines, a row range is selected (no single cell active), and the user presses ⌘V
- **THEN** three new pending insert rows are appended to the grid, one per line

#### Scenario: Paste a single-line clipboard creates one pending row

- **WHEN** the clipboard holds one tab-separated line and the user presses ⌘V with a row range selected
- **THEN** one new pending insert row is appended to the grid

#### Scenario: Pasted rows are pending, not yet persisted

- **WHEN** rows are pasted
- **THEN** they appear as unsaved pending insert rows and are persisted only when the user invokes the existing Save action

#### Scenario: Postgres parity with MySQL/MSSQL

- **WHEN** the user pastes a row range into the Postgres grid
- **THEN** pending insert rows are created identically to the MySQL and MSSQL grids

### Requirement: Clipboard columns map to grid columns by position

The TSV parser SHALL split the clipboard text into lines (on `\n`, tolerating a trailing `\r`) and each line into cells (on `\t`), and map cells to grid columns **by position** in column order — the inverse of the shared row-TSV formatter used by row-range copy. A copy-then-paste round-trip of the same rows MUST reproduce the source rows' displayed cell values. Empty cells (`\t\t`) MUST map to an empty/NULL-equivalent value consistent with how the formatter serialized SQL `NULL` (empty string). When a line has fewer cells than the grid has columns, the missing trailing columns MUST be left unset (relying on database defaults on Save); when a line has more cells than columns, the extra trailing cells MUST be ignored.

#### Scenario: Copy-then-paste round-trip reproduces values

- **WHEN** a row is copied to the clipboard as TSV and then pasted into the same grid
- **THEN** the new pending insert row's editable cell values match the copied row's displayed values

#### Scenario: Empty TSV cell maps to NULL-equivalent

- **WHEN** a pasted line contains an empty cell between two tabs
- **THEN** the corresponding column of the new pending row is unset / NULL-equivalent

#### Scenario: Short line leaves trailing columns unset

- **WHEN** a pasted line has fewer cells than the grid has columns
- **THEN** the missing trailing columns are left unset so the database default fires on Save

#### Scenario: Long line ignores extra cells

- **WHEN** a pasted line has more cells than the grid has columns
- **THEN** the extra trailing cells are ignored and no error is raised

### Requirement: Paste does not force auto-generated columns

Pasting rows MUST produce the same pending insert payload the "add row" affordance creates: columns the user did not (and cannot meaningfully) supply — specifically auto-generated / default-backed columns such as `SERIAL`/identity/auto-increment primary keys — MUST NOT be forced from the pasted values in a way that overrides the database default. Duplicating a row via paste MUST let the database assign a fresh key on Save rather than attempting to insert the source row's key. This mirrors the existing insert `EditOp` contract where columns omitted from `values` fall through to the database default.

#### Scenario: Duplicated row gets a fresh primary key

- **WHEN** a row whose primary key is a `SERIAL`/identity column is copied and pasted, then saved
- **THEN** the inserted row receives a new database-assigned primary key rather than the source row's key

### Requirement: Row-paste and cell editing are mutually exclusive

Row paste SHALL fire only when a row range is selected and no single cell is active. While a cell is in edit mode (an input/textarea/select has focus), ⌘V / Ctrl+V MUST NOT trigger row paste; the browser's native paste into the editor MUST apply. When a single cell is active but not in edit mode, row paste MUST NOT fire.

#### Scenario: Native paste inside an open editor

- **WHEN** a cell is in edit mode and the user presses ⌘V
- **THEN** the clipboard text is pasted into the editor by the browser and no pending insert rows are created

#### Scenario: Active cell suppresses row paste

- **WHEN** a single cell is active (even if a prior row range existed) and the user presses ⌘V
- **THEN** no pending insert rows are created via the row-paste path

#### Scenario: No selection pastes nothing

- **WHEN** neither a single cell nor a row range is selected and the user presses ⌘V
- **THEN** the grid does not create pending insert rows

### Requirement: Paste failures are surfaced to the user

When a paste fails — the clipboard read throws, the clipboard is empty, or the content parses to zero usable rows — the grid SHALL surface a non-blocking error notification via the app toast primitive rather than silently swallowing the failure. A successful paste MUST NOT show a notification. The notification MUST NOT fire on a no-op (e.g. ⌘V with no row range selected, which does not enter the paste path at all).

#### Scenario: Clipboard read failure shows an error toast

- **WHEN** the user presses ⌘V on a selected row range and `navigator.clipboard.readText()` throws
- **THEN** a non-blocking error toast is shown and the failure is not silently swallowed

#### Scenario: Empty clipboard shows an error toast

- **WHEN** the user presses ⌘V on a selected row range and the clipboard is empty or parses to zero rows
- **THEN** a non-blocking error toast is shown and no pending rows are created

#### Scenario: Successful paste is silent

- **WHEN** the user presses ⌘V on a selected row range and rows are successfully appended
- **THEN** no toast is shown

