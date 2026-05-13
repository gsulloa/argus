## ADDED Requirements

### Requirement: Drag-to-select row range

The data grid SHALL support multi-row selection via vertical mouse drag inside the body region. The viewer MUST track selection as a pair `{ anchor: number | null, active: number | null }` where `anchor` is the row index where the drag started and `active` is the row index currently (or most recently) under the cursor. The set of selected indices MUST be derived as the inclusive range `[min(anchor, active), max(anchor, active)]`. When `anchor === null`, no rows are selected.

Mouse interaction MUST follow these rules:

- **Mouse-down on a row** sets `anchor = active = rowIndex` but does NOT yet visually commit a multi-row selection; the drag intent is unresolved until the cursor has moved at least 4 pixels (vertically OR horizontally) from the mouse-down position.
- **Mouse-move while in drag-pending state**: if the cursor has moved < 4px, the gesture is still a click; if it has moved ≥ 4px, the gesture transitions to drag-active and `active` updates on every subsequent mousemove to the row index under the cursor (computed from `scrollTop` and `clientY`, NOT from DOM presence — virtualized rows that are not mounted are still selectable).
- **Mouse-move near the body's top or bottom edge** (within 20px) while drag-active MUST trigger auto-scroll of the grid viewport in that direction, so the user can extend the selection past the visible viewport. Auto-scroll velocity MUST be proportional to how close the cursor is to the edge.
- **Mouse-up while drag-active** finalizes the selection at `[anchor, active]` and exits drag mode. The selection remains until cleared.
- **Mouse-up while drag-pending** (cursor never crossed the threshold) is treated as a click: if the clicked row was already selected as a single row, deselect (`anchor = active = null`); otherwise select that single row (`anchor = active = rowIndex`).
- **Mouse-up outside the grid**: the same finalization MUST apply (the grid listens for `mouseup` on `document` while drag is active so the gesture can complete even if the cursor leaves).

Selected rows MUST render with the same `data-selected="true"` attribute and `--accent-soft` background already used for single-row selection. No new design tokens are introduced. The selection MUST survive vertical scroll and tail pagination. The selection MUST be cleared when the user changes sort, filter, or page size (consistent with the existing buffer reset behavior on those events). The selection MUST be cleared when the user presses `Escape` outside of an active inline editor.

When the user clicks the same row a second time without dragging, the row is deselected. When the user clicks a different row without dragging, the previous selection is replaced by the new single-row selection (no Cmd/Shift extend in this capability).

#### Scenario: Click without drag selects a single row

- **WHEN** the user mouse-downs on row 5 and mouse-ups within 4px without moving
- **THEN** the selection is `{ anchor: 5, active: 5 }`
- **AND** only row 5 has `data-selected="true"`

#### Scenario: Drag from row 5 to row 8 selects rows 5..8

- **WHEN** the user mouse-downs on row 5, drags vertically down through rows 6 and 7, and mouse-ups on row 8
- **THEN** the selection is `{ anchor: 5, active: 8 }`
- **AND** rows 5, 6, 7, 8 all render with `data-selected="true"`

#### Scenario: Drag past the visible viewport triggers auto-scroll

- **WHEN** the user starts a drag at row 5 (visible) and moves the cursor to within 20px of the body's bottom edge
- **THEN** the grid's vertical scroll position advances downward continuously while the cursor stays in the edge zone
- **AND** `active` continues to update to the row index under the cursor as new rows scroll into view
- **AND** the auto-scroll stops when the cursor moves out of the edge zone or when the user releases the mouse

#### Scenario: Selection survives virtualization (drag into unmounted rows)

- **WHEN** the user drags from row 5 into row 9500 of a 10000-row buffer (rows 50–9499 are never DOM-mounted because of virtualization)
- **THEN** the selection is `{ anchor: 5, active: 9500 }`
- **AND** when the user later scrolls to any row in `[5, 9500]`, that row renders selected

#### Scenario: Drag below 4px threshold remains a click

- **WHEN** the user mouse-downs on row 5 and mouse-ups after moving the cursor only 2 pixels
- **THEN** the gesture is treated as a single click
- **AND** the selection is `{ anchor: 5, active: 5 }` (single row)

#### Scenario: Mouse-up outside the grid still finalizes the selection

- **WHEN** the user starts a drag on row 5, moves the cursor outside the grid (over the inspector panel or browser chrome) past the 4px threshold, and releases the mouse there
- **THEN** the selection is finalized at the last `active` value computed while the cursor was over the grid
- **AND** no drag state remains active

#### Scenario: Sort change clears the selection

- **WHEN** the user has rows 5..10 selected and changes the sort
- **THEN** the buffer is reset (existing behavior) and the selection becomes `{ anchor: null, active: null }`

#### Scenario: Escape clears the selection outside of an editor

- **WHEN** the user has rows 5..10 selected and no inline editor is active
- **AND** presses Escape
- **THEN** the selection becomes `{ anchor: null, active: null }`

#### Scenario: Click a different row replaces the selection

- **WHEN** the user has rows 5..10 selected and single-clicks row 20 without dragging
- **THEN** the selection becomes `{ anchor: 20, active: 20 }`

## MODIFIED Requirements

### Requirement: Virtualized data grid

The viewer tab SHALL render the rows in a virtualized grid powered by `@tanstack/react-table` for column / row modeling and `@tanstack/react-virtual` for vertical row virtualization. The grid MUST keep DOM row count proportional to the visible viewport (not to the dataset size) so that loading 10k+ rows is smooth. The grid MUST display column names in `Geist Mono` (the codebase token), tabular numerals for numeric and date columns, and a single hairline divider between rows (per `DESIGN.md`). Rows belonging to the active selection range (see "Drag-to-select row range") MUST be highlighted with the `--accent-soft` background. Cell padding MUST be the compact density specified in `DESIGN.md` (`5px 12px`). Long values MUST be truncated with an ellipsis at the cell boundary; full content is shown via the inspector panel.

When the connection is writable AND the relation has a PK, the grid MUST also render in editable mode: cells edited via the buffer (kind `update` or `insert`) MUST be rendered with a dirty-state background distinct from `--accent-soft` (a softer warning hue, formalized in `DESIGN.md` as part of this change if not already present); rows marked for delete (kind `delete`) MUST be rendered with strike-through text and a faded foreground color; insert rows MUST be rendered at the top of the buffer with their dirty cells styled the same as updated cells.

#### Scenario: Loading 10k rows stays responsive

- **WHEN** the user has loaded a table with 10,000 buffered rows
- **THEN** the grid renders no more than `viewport_height / row_height + overscan` row DOM nodes at any time
- **AND** scrolling does not block the main thread for visibly long stalls

#### Scenario: Selected rows use the accent-soft stripe

- **WHEN** the user selects rows 5..10
- **THEN** each of rows 5, 6, 7, 8, 9, 10 has its background using the `--accent-soft` token from `DESIGN.md`
- **AND** the inspector panel updates to the `active` row of the selection

#### Scenario: Dirty cell has a distinct background

- **WHEN** the user edits a cell so that it is now in the buffer's `update` set
- **THEN** that cell renders with the dirty-state background
- **AND** the dirty-state background is visually distinct from the selection `--accent-soft` highlight (so a selected row with one dirty cell shows both states)

#### Scenario: Row marked for delete is rendered struck through

- **WHEN** the user marks a row for delete
- **THEN** that row's text is rendered with strike-through and a faded foreground color
- **AND** the row remains visible (not hidden) until commit

#### Scenario: Insert row appears at the top of the buffer

- **WHEN** the user clicks "Add row"
- **THEN** the new row appears as the first row in the visible buffer
- **AND** does not move when the active sort changes (insert rows keep their position until commit)

### Requirement: Bottom bar status

The viewer SHALL display a bottom bar with: a row counter `Showing <N> rows · Page <P>` (where N is the current buffer size and P is the highest loaded page), the page-size selector, a `Count rows` button, an inline `query_ms` indicator from the most recent successful `postgres.queryTable`, and a clear-filters affordance when one or more filters are active. After the user clicks `Count rows`, the bar MUST replace `Showing <N> rows` with `Showing <N> of <Total> rows`, where Total is the result of `postgres_count_table` honoring the active filters. The total MUST be invalidated whenever the filter set changes (so the user must click `Count rows` again for the new filter set).

When the viewer is in editable mode, the bottom bar MUST also render: an "Add row" button (hidden on views/materialized views), a "Save" button enabled only when the buffer has dirty entries (showing `Save (<N>)` where N is the count of pending operations), and an unsaved-changes indicator. When the connection is read-only, the bottom bar MUST instead render a "Read-only connection — edits disabled" banner replacing the "Add row" / "Save" controls. When the relation has no PK on a writable connection, the bottom bar MUST render a "No primary key — existing rows are not editable" banner alongside the "Add row" button.

When the selection range contains 2 or more rows, the bottom bar MUST render a selection chip to the left of the dirty-count indicator showing `<N> rows selected` followed by a `Clear` button. The chip MUST use `--accent-soft` as background and `--accent` as text color (tokens from `DESIGN.md`). The `Clear` button MUST reset the selection to `{ anchor: null, active: null }` without modifying the edit buffer. The chip MUST NOT be rendered when the selection contains 0 or 1 row (zero-noise rule).

#### Scenario: Default bar shows partial info

- **WHEN** the user has 400 rows buffered across two pages and has not clicked `Count rows`
- **THEN** the bar reads `Showing 400 rows · Page 2`, plus the page-size selector, the `Count rows` button, and the most recent `query_ms`

#### Scenario: Count rows updates the indicator

- **WHEN** the user clicks `Count rows` and the count returns `12,345`
- **THEN** the bar reads `Showing 400 of 12,345 rows · Page 2`

#### Scenario: Filter change invalidates the count

- **WHEN** the bar shows `Showing 400 of 12,345 rows` and the user adds a new column filter
- **THEN** the bar reverts to `Showing <N> rows · Page <P>` and the user must click `Count rows` again to get a count under the new filters

#### Scenario: Save button reflects pending edit count

- **WHEN** the user has 2 dirty cells and has marked 1 row for delete
- **THEN** the bar's Save button reads `Save (3)` and is enabled

#### Scenario: Read-only banner replaces edit controls

- **WHEN** the user is viewing a table on a connection with `params.read_only: true`
- **THEN** the bottom bar does NOT render the "Add row" or "Save" controls
- **AND** the bar shows a banner reading "Read-only connection — edits disabled"

#### Scenario: No-PK banner appears alongside Add row

- **WHEN** the user is viewing a table without a PK on a writable connection
- **THEN** the bar shows the "Add row" button (insert is allowed)
- **AND** also shows a banner reading "No primary key — existing rows are not editable"

#### Scenario: Selection chip appears when 2+ rows are selected

- **WHEN** the user has selected rows 5..12 by dragging
- **THEN** the bottom bar renders a chip `8 rows selected · Clear` to the left of the dirty-count indicator
- **AND** the chip uses `--accent-soft` background and `--accent` text color

#### Scenario: Selection chip is hidden for single-row selection

- **WHEN** the user has selected exactly one row
- **THEN** the bottom bar does NOT render the selection chip

#### Scenario: Clear button clears selection without touching the buffer

- **WHEN** the user has rows 5..12 selected and 3 dirty cells in the buffer
- **AND** clicks the chip's `Clear` button
- **THEN** the selection becomes `{ anchor: null, active: null }`
- **AND** the 3 dirty cells remain in the buffer
- **AND** the chip disappears (selection count is 0)
