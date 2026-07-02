## MODIFIED Requirements

### Requirement: Result panel for rows and affected outcomes

Each `postgres-query` tab SHALL render a result panel below the editor. The panel MUST:

- Render a hint state when no run has occurred yet in this tab. The hint MUST advertise both run and autocomplete shortcuts so the user discovers them on first use; the recommended copy is `Press ⌘↩ to run · Tab to autocomplete`.
- Render a virtualized read-only data grid (the `<AdhocResultGrid />` provided by `postgres-data-grid`) for `kind: "rows"` results, displaying the `columns` and `rows` from the response. The grid MUST support **row-range selection** (via a row-number gutter: plain click, shift-click, and drag) as well as single-cell selection, and the current row selection MUST drive the shell's right inspector (when the inspector is expanded) — a single-row selection shows one row, a multi-row selection shows all selected rows. The grid MUST support ⌘C / Ctrl+C copy (single cell or the selected row range as TSV), ⌘A / Ctrl+A select-all, and a read-only right-click context menu (Copy cell / Copy row(s)), per the `grid-cell-copy`, `grid-row-copy`, `grid-row-selection`, `grid-select-all`, and `grid-context-menu` capabilities. Column widths inside the grid MUST default to the type-derived base widths defined by `column-width-preferences` and MUST be user-resizable; resizing MUST NOT persist to disk across runs or sessions, but MUST persist within the same `<AdhocResultGrid />` instance for as long as the columns prop shape is unchanged.
- Render a compact summary line for `kind: "affected"` results: `<command_tag> · <affected_rows> rows affected · <query_ms> ms`. Example: `INSERT 0 3 · 3 rows affected · 12 ms`.
- Display a banner above the grid `Result truncated at 10,000 rows — add a LIMIT clause to refine.` whenever the response has `truncated: true`.

The panel's height MUST be resizable via a drag handle on its top edge (between editor and panel) within bounds 120–800px; the height MUST persist per tab id under settings key `pgQueryResultHeight:<tabId>` while the tab exists.

#### Scenario: Empty state on fresh tab advertises run + autocomplete

- **WHEN** a `postgres-query` tab is opened and no run has been executed
- **THEN** the panel shows the hint `Press ⌘↩ to run · Tab to autocomplete`
- **AND** no grid is rendered

#### Scenario: Rows result renders the adhoc grid

- **WHEN** a SELECT returns 50 rows with 4 columns
- **THEN** the panel renders an `<AdhocResultGrid />` with those 50 rows and 4 columns
- **AND** selecting a row from the gutter populates the shell's right inspector with that row's column-value list

#### Scenario: Multi-row selection drives the inspector

- **WHEN** the user selects a range of rows (e.g. rows 2–4) via the gutter in the result grid
- **THEN** the shell's right inspector shows the column-value view for all selected rows

#### Scenario: Copy selected rows from the result grid

- **WHEN** the user selects rows 2–4 in the result grid and presses ⌘C
- **THEN** those three rows are copied to the clipboard as TSV

#### Scenario: Affected result renders the compact summary

- **WHEN** an INSERT returns `{ kind: "affected", command_tag: "INSERT 0 3", affected_rows: 3, query_ms: 12 }`
- **THEN** the panel shows `INSERT 0 3 · 3 rows affected · 12 ms`
- **AND** no grid is rendered

#### Scenario: Truncation banner surfaces above the grid

- **WHEN** a SELECT returns 10,000 rows with `truncated: true`
- **THEN** a banner reads `Result truncated at 10,000 rows — add a LIMIT clause to refine.` above the grid

#### Scenario: Adhoc grid column widths reset when columns prop changes

- **WHEN** the user runs `SELECT id, email FROM users`, resizes `email` to 320px, then runs `SELECT id, email, status FROM users` in the same tab
- **THEN** the new result re-renders the grid with `id`, `email`, and `status` at their type-derived base widths
- **AND** the previous 320px override for `email` is discarded
