## MODIFIED Requirements

### Requirement: Drag-to-select row range

The data grid SHALL support multi-row selection via vertical mouse drag inside the body region. The viewer MUST track selection as a pair `{ anchor: number | null, active: number | null }` where `anchor` is the row index where the drag started and `active` is the row index currently (or most recently) under the cursor. The set of selected indices MUST be derived as the inclusive range `[min(anchor, active), max(anchor, active)]`. When `anchor === null`, no rows are selected.

The grid body MUST NOT allow the browser's native text selection to engage during click or drag interactions on the row display path. The rendered row and cell elements (`.row`, `.cell` in the display path) MUST have `user-select: none` (with the `-webkit-user-select: none` prefix for Tauri Webview compatibility) applied via CSS. The row's primary-button `mousedown` handler MUST call `event.preventDefault()` after confirming `event.button === 0`, so the browser does not start a text-selection drag or other default mousedown behavior. The inline cell editor wrapper (`.cellEditing`) and the editor input element (`.cellEditor`, including textarea and select variants) MUST re-enable `user-select: text` so the user can select, copy, and edit text inside the active editor normally.

Mouse interaction MUST follow these rules:

- **Mouse-down on a row** (primary button only) sets `anchor = active = rowIndex` but does NOT yet visually commit a multi-row selection; the drag intent is unresolved until the cursor has moved at least 4 pixels (vertically OR horizontally) from the mouse-down position. The mousedown handler MUST call `event.preventDefault()` to suppress native text-selection and drag-image side effects. `event.preventDefault()` on mousedown MUST NOT prevent the subsequent synthesized `dblclick` event from firing, so the double-click-to-edit affordance on cells remains intact.
- **Mouse-move while in drag-pending state**: if the cursor has moved < 4px, the gesture is still a click; if it has moved ≥ 4px, the gesture transitions to drag-active and `active` updates on every subsequent mousemove to the row index under the cursor (computed from `scrollTop` and `clientY`, NOT from DOM presence — virtualized rows that are not mounted are still selectable).
- **Mouse-move near the body's top or bottom edge** (within 20px) while drag-active MUST trigger auto-scroll of the grid viewport in that direction, so the user can extend the selection past the visible viewport. Auto-scroll velocity MUST be proportional to how close the cursor is to the edge.
- **Mouse-up while drag-active** finalizes the selection at `[anchor, active]` and exits drag mode. The selection remains until cleared.
- **Mouse-up while drag-pending** (cursor never crossed the threshold) is treated as a click and MUST unconditionally set the selection to `{ anchor: rowIndex, active: rowIndex }`. Clicking a row that is already the sole selected row MUST be a no-op (the row remains selected). There is NO toggle-deselect-on-second-click behavior.
- **Mouse-up outside the grid**: the same finalization MUST apply (the grid listens for `mouseup` on `document` while drag is active so the gesture can complete even if the cursor leaves).

Inline cell editing MUST be reachable ONLY via a double-click on an editable cell (a cell that is not read-only and whose value is not a binary / envelope / no-PK marker). A single click on any cell — selected row or not, editable or read-only — MUST NOT enter inline edit mode. The `onDoubleClick` handler on the cell display element is the sole entry point to `onStartEdit`.

Selected rows MUST render with the same `data-selected="true"` attribute and `--accent-soft` background already used for single-row selection. No new design tokens are introduced. The selection MUST survive vertical scroll and tail pagination. The selection MUST be cleared when the user changes sort, filter, or page size (consistent with the existing buffer reset behavior on those events). The selection MUST be cleared when the user presses `Escape` outside of an active inline editor, or when the user clicks the `Clear` chip in the bottom bar (when present for 2+ row selections).

When the user clicks a different row without dragging, the previous selection is replaced by the new single-row selection (no Cmd/Shift extend in this capability).

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

#### Scenario: Clicking the same row twice keeps it selected (no toggle-deselect)

- **WHEN** the user single-clicks row 5 and then single-clicks row 5 again without dragging
- **THEN** the selection remains `{ anchor: 5, active: 5 }` after both clicks
- **AND** row 5 still renders with `data-selected="true"`

#### Scenario: Dragging inside the grid does not highlight cell text

- **WHEN** the user mouse-downs on a cell that contains text (e.g., a `varchar` column with the value `"hello world"`) and drags horizontally and vertically across multiple cells and rows
- **THEN** no cell content is highlighted by the browser's native text selection (no blue / accent-tinted text selection appears within `.cell` elements)
- **AND** the drag is interpreted as a row-range selection per the standard drag rules
- **AND** `window.getSelection()?.toString()` returns an empty string after the drag completes

#### Scenario: Single click on an editable cell selects the row but does not enter edit mode

- **WHEN** the user single-clicks an editable cell (e.g., a non-PK `text` column in row 7)
- **THEN** the selection is `{ anchor: 7, active: 7 }`
- **AND** no inline editor is rendered (`editing` state remains `null`)
- **AND** the cell continues to render in the display path (showing the `DisplayContent` span, not an `<input>` / `<textarea>` / `<select>`)

#### Scenario: Double click on an editable cell enters edit mode

- **WHEN** the user double-clicks an editable cell in row 7, column `name`
- **THEN** the inline editor for `name` in row 7 is rendered with the cell's current value
- **AND** the editor input is focused and its text is auto-selected (per the existing `cur.select()` behavior)
- **AND** the row's selection state is unchanged by the double-click itself (selection follows the mousedown sequence)

#### Scenario: Double click on a read-only cell does not enter edit mode

- **WHEN** the user double-clicks a read-only cell (e.g., a PK column of a server row, or a `bytea` column, or a value envelope)
- **THEN** no inline editor is rendered
- **AND** the row's selection state follows the same rules as a single click (the row becomes the active single-row selection)

#### Scenario: Text inside the active inline editor is selectable

- **WHEN** an inline editor is active on a `text` cell containing `"hello world"`
- **AND** the user click-drags inside the input element to select the substring `"hello"`
- **THEN** the input's native text selection covers `"hello"` and `window.getSelection()` (or the input's `selectionStart`/`selectionEnd`) reflects that range
- **AND** the row-level drag-to-select state machine is NOT engaged (the editor's stopPropagation / focus behavior keeps the row mousedown handler inert)
