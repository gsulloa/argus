## ADDED Requirements

### Requirement: Grid copy failures are surfaced to the user

When a grid clipboard write fails (row-range or single-cell copy), the grid SHALL surface a non-blocking error notification to the user (via the app toast primitive) rather than silently swallowing the error. A successful copy MUST NOT show a notification. The notification MUST fire only on actual write failure, not on a no-op (e.g. `⌘C` with nothing selected).

#### Scenario: Copy failure shows an error toast

- **WHEN** the user presses `⌘C` on a selected row range and the clipboard write throws
- **THEN** a non-blocking error toast is shown to the user
- **AND** the failure is not silently swallowed

#### Scenario: Successful copy is silent

- **WHEN** the user presses `⌘C` on a selected row range and the clipboard write succeeds
- **THEN** no toast is shown

## MODIFIED Requirements

### Requirement: Copy selected row range as TSV with Cmd+C

In every editable data grid — Postgres, MySQL, and MSSQL — when a row range is selected (a non-null `selection` anchor/active) and **no** single cell is active, pressing ⌘C (macOS) or Ctrl+C (other platforms) SHALL copy every row in the selected range to the system clipboard as tab-separated values. The copy MUST be triggered from the grid's own keyboard handler (the same handler that performs single-cell copy) and MUST write to the clipboard programmatically (`navigator.clipboard`), rather than relying on the browser's native `copy` clipboard event — which does not fire in the desktop WKWebView when a row selection is not backed by a DOM text selection. The serialized text MUST place one row per line (rows joined by `\n`) with cells joined by a tab (`\t`), in column order, and MUST be produced by the shared row formatter (see "Row TSV formatting"). This behaviour MUST be consistent across all three editable grids.

#### Scenario: Copy a multi-row selection

- **WHEN** the user selects rows 2 through 4 (no single cell active) and presses ⌘C
- **THEN** the system clipboard contains three lines, one per row, each line being that row's cell values joined by tabs

#### Scenario: Copy a single selected row

- **WHEN** exactly one row is selected as a row range and the user presses ⌘C
- **THEN** the system clipboard contains that one row's cell values joined by tabs

#### Scenario: Copy works in the desktop webview without a DOM text selection

- **WHEN** a row range is selected in the packaged desktop app (macOS WKWebView) with no native text selection present and the user presses ⌘C
- **THEN** the selected rows are written to the system clipboard as TSV
- **AND** the copy does not depend on a native `copy` clipboard event being dispatched

#### Scenario: Postgres parity with MySQL/MSSQL

- **WHEN** the user selects a row range in the Postgres grid and presses ⌘C
- **THEN** rows are copied as TSV identically to the MySQL and MSSQL grids
