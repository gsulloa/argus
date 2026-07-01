## ADDED Requirements

### Requirement: Copy selected row range as TSV with Cmd+C in the ad-hoc SQL result grid

In the read-only ad-hoc SQL result grid (`AdhocResultGrid`, used by the Postgres SQL editor), when a row range is selected (a non-null `selection` anchor/active) and **no** single cell is active, pressing ⌘C (macOS) or Ctrl+C (other platforms) SHALL copy every row in the selected range to the system clipboard as tab-separated values. The copy MUST be triggered from the grid's own keyboard handler (the same handler that performs single-cell copy) and MUST write to the clipboard programmatically (`navigator.clipboard`), rather than relying on the browser's native `copy` clipboard event — which does not fire in the desktop WKWebView when a row selection is not backed by a DOM text selection. The serialized text MUST place one row per line (rows joined by `\n`) with cells joined by a tab (`\t`), in column order, and MUST be produced by the same shared row formatter used by the editable grids, so the output is byte-identical.

Row-range copy MUST remain mutually exclusive with single-cell copy: when a single cell is active, ⌘C copies that cell only. The copy path MUST NOT be intercepted when focus is inside a native text input.

#### Scenario: Copy a multi-row selection from the ad-hoc grid

- **WHEN** the user selects rows 2 through 4 (no single cell active) in the ad-hoc SQL result grid and presses ⌘C
- **THEN** the system clipboard contains three lines, one per row, each line being that row's cell values joined by tabs

#### Scenario: Copy a single selected row from the ad-hoc grid

- **WHEN** exactly one row is selected as a row range in the ad-hoc SQL result grid and the user presses ⌘C
- **THEN** the system clipboard contains that one row's cell values joined by tabs

#### Scenario: Copy works in the desktop webview without a DOM text selection

- **WHEN** a row range is selected in the ad-hoc SQL result grid in the packaged desktop app (macOS WKWebView) with no native text selection present and the user presses ⌘C
- **THEN** the selected rows are written to the system clipboard as TSV
- **AND** the copy does not depend on a native `copy` clipboard event being dispatched

#### Scenario: Ad-hoc result copy matches editable-grid output

- **WHEN** the same row values are copied from the ad-hoc SQL result grid and from an editable data grid
- **THEN** the resulting TSV text is identical (same cell formatting, tab and newline separators)

#### Scenario: Single-cell copy still wins when a cell is active

- **WHEN** a single cell is active in the ad-hoc SQL result grid and the user presses ⌘C
- **THEN** only that cell's value is copied, not a row range
