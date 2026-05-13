## 1. Buffer: batched bulk actions

- [x] 1.1 Add `bulk-set-cell` action to the `useEditBuffer` reducer in `src/modules/postgres/data/useEditBuffer.ts` that accepts `entries: Array<{ rowKey, column, value, pk, originalRow, originalColumns }>` and applies them in a single reducer pass, pushing a single `UndoEntry` representing the whole batch.
- [x] 1.2 Add `bulk-delete-toggle` action to the same reducer that accepts `entries: Array<{ rowKey, source: "insert" | "server", pk?: Record<string, EditValue>, currentlyDeleted: boolean }>` and per-entry decides remove-insert / mark-delete / unmark-delete. Pushes a single `UndoEntry` covering all entries.
- [x] 1.3 Extend the `UndoEntry` type to encode either a single-row action (existing) or a multi-row batch action (new variants for bulk-set-cell and bulk-delete-toggle), and update the `undo` reducer branch to revert batches as one step.
- [x] 1.4 Expose `bulkSetCellEdit(entries)` and `bulkDeleteToggle(entries)` from `UseEditBufferResult` (alongside the existing single-row methods, which keep working unchanged).
- [x] 1.5 Update `useEditBuffer.test.ts` (or create it if missing) with cases for: bulk-set over 10 rows × 2 columns → 20 dirty cells across 10 update entries with one undo, single-undo reverts all 20, bulk-delete-toggle on mixed selection (insert + clean + already-deleted), undo reverts the mixed batch.

## 2. Selection model in DataGrid

- [x] 2.1 In `src/modules/postgres/data/DataGrid.tsx`, replace `selectedRowIndex: number | null` (and the `onSelectRow` callback prop) with `selection: { anchor: number | null, active: number | null }` and `onSelectionChange(next)`. Update the prop in `DataGridProps`.
- [x] 2.2 Derive `selectedIndices` range bounds from `selection`. Replace the existing `selected = selectedRowIndex === vi.index` per-row check with a range check.
- [x] 2.3 Update `TableViewerTab.tsx` to own `selection` state, pass it to `DataGrid`, and use `selection.active` for the inspector's "active row" binding (the inspector still receives the active single row in single-row mode).
- [x] 2.4 Clear `selection` on sort change, filter change, and page-size change in `TableViewerTab.tsx` (consistent with the existing buffer-reset triggers).

## 3. Drag-to-select implementation

- [x] 3.1 Add a `dragRef` (`useRef`) in `DataGrid` to hold drag state: `{ status: "pending" | "active", anchorIndex, anchorClientX, anchorClientY }`.
- [x] 3.2 Implement `onMouseDown` on each row that captures `anchorIndex = vi.index`, `anchorClientX/Y = e.clientX/Y`, and sets `dragRef.current.status = "pending"`. Do NOT yet update `selection`.
- [x] 3.3 Implement a `useEffect` that, while a drag is in flight, attaches `mousemove` and `mouseup` listeners to `document` (and removes them on cleanup). Mouse-move computes distance from the anchor and, once ≥4px, transitions status to `active` and updates `selection.active` to the row index under the cursor (computed via `Math.floor((scrollTop + clientY - bodyRect.top) / ROW_HEIGHT)`, clamped to `[0, rows.length - 1]`). Mouse-up finalizes: if status reached `active`, leave the current `selection` as-is; if it stayed `pending`, toggle single-select behavior of the anchor row.
- [x] 3.4 Implement auto-scroll in the same `useEffect`: when `clientY` is within 20px of `bodyRect.top` or `bodyRect.bottom` during an active drag, scroll the viewport by an amount proportional to the edge distance per `requestAnimationFrame` tick, until the cursor leaves the edge zone or the drag ends.
- [x] 3.5 Add an Escape-key handler at the grid level (extending the existing `onGridKeyDown`) that, when no inline editor is active and there is a selection, clears `selection` to `{ anchor: null, active: null }`.
- [x] 3.6 Remove the existing `onClick={() => onSelectRow(selected ? null : vi.index)}` toggle from the row `<div>` — its responsibility is now folded into `onMouseDown` + the drag-end `pending` path in step 3.3. Make sure single-click still toggles single selection.
- [x] 3.7 Add a small unit test (or a manually scripted dev verification) of the `pixelY → rowIndex` math (`ROW_HEIGHT` and clamp behavior). Verify drag below the visible viewport works against a 10k-row buffer in dev.

## 4. Suppress inline cell edit during bulk mode

- [x] 4.1 In `DataGrid.tsx`, accept a new prop `bulkEditActive: boolean` (computed in `TableViewerTab` from the effective selection count ≥ 2 AND `pkColumns !== null`).
- [x] 4.2 When `bulkEditActive === true`, the cell's `onStartEdit` handler MUST be a no-op (no double-click opens the inline editor). The `EditableCell` itself does NOT need to change — `DataGrid` simply does not call `setEditing` while bulk is active.
- [x] 4.3 When `bulkEditActive === true`, set `cursor: default` on the cell `<div>`s (CSS class toggle) so the user sees no text caret on hover. When false, retain existing behavior.

## 5. Inspector bulk-edit mode

- [x] 5.1 In `src/modules/postgres/data/Inspector.tsx`, change the props from `row + rowKey` (single) to `selectedRows: Array<{ rowKey: string, row: CellValue[], pk: Record<string, EditValue>, source: "insert" | "server", isDeleted: boolean }>`. Also accept `bulkEditAvailable: boolean` (true when the connection is writable and `pkColumns !== null`).
- [x] 5.2 In `TableViewerTab.tsx`, derive `selectedRows` from the `selection` range + the unified row buffer. Pass the array to the inspector. For single-row mode, the array has 0 or 1 entry; for bulk mode it has ≥2 entries (raw — filtering happens inside the inspector).
- [x] 5.3 Inside `Inspector.tsx`, compute `eligibleRows = selectedRows.filter(r => r.source === "server" && !r.isDeleted && r.rowKey)`. Define `mode = eligibleRows.length >= 2 && bulkEditAvailable ? "bulk" : "single"`.
- [x] 5.4 When `mode === "single"`, render the existing single-row inspector unchanged. The "active row" is `selectedRows[selectedRows.length - 1]` (or `null` if the selection is empty).
- [x] 5.5 When `mode === "bulk"`:
  - Update the header to `Inspector · <eligibleRows.length> rows selected`.
  - For each column in `columns`, compute per-column eligibility: `bulkEditableCol = !pkColumns.includes(col.name) && !looksLikeBytea(col.data_type) && !eligibleRows.some(r => isCellEnvelope(r.row[colIdx])) && !isReadOnly`.
  - For each non-editable column in bulk mode, render a read-only `<div>` with a tooltip explaining why (PK / binary / envelope / read-only).
  - For each editable column, render a new `InspectorBulkField` component (defined in 5.6).
- [x] 5.6 Create `InspectorBulkField` (new component, can live in the same file or a new `InspectorBulkField.tsx`). Props: `column, eligibleRows, enumValues, columnIndex, onTouchedChange(touched: boolean)`. Internal state: `text: string`, `touched: boolean`, `jsonError: string | null`, `jsonWarning: boolean`. Initial state computed from `eligibleRows`:
  - Compute `pristineValue` = the common value across all `eligibleRows[*].row[columnIndex]` (structural equality for objects/arrays, strict for scalars), or `null` if values differ.
  - If `pristineValue !== null` (common value exists): initialize `text = valueToText(pristineValue)`, render the field as if value is `pristineValue`.
  - If `pristineValue === null` (values differ): initialize `text = ""`, render the input/textarea with `placeholder="— multiple values —"`. For select-based fields (boolean/enum), render with a "(no change)" first option that is selected by default.
- [x] 5.7 Per-type input rendering inside `InspectorBulkField` mirrors `InspectorEditableField`:
  - Boolean: `<select>` with options `true`, `false`, `NULL` (if nullable), plus a leading `(no change)` option when bulk-mode and the field is pristine. Selecting `(no change)` keeps `touched = false`. Selecting any other option sets `touched = true`.
  - Enum: `<select>` with the enum values + `(NULL)` if nullable, plus a leading `(no change)` pristine option. Same touched semantics.
  - JSON/long-text: `<textarea>` with `placeholder="— multiple values —"`. Any keystroke that changes the text sets `touched = true`.
  - Numeric/text: `<input>`. Any keystroke that changes the text sets `touched = true`.
- [x] 5.8 Touched indicator: when `touched === true`, apply a CSS class to the field root that renders an accent-colored left border and shows the `●` dot inside the existing `styles.label` markup. Also render an `↺` button (Lucide `Undo2` icon at 11px, or a styled text button) next to the input that resets `touched = false`, resets `text` to pristine, clears `jsonError`/`jsonWarning`.
- [x] 5.9 Bubble `touched` up via `onTouchedChange` so the inspector can compute the total `touchedCount` for enabling/disabling the Apply button. Also expose the field's current value (or imperative `read()` via a `ref`) so the inspector can collect values on Apply. Recommended: lift `touched` and `text` state to the inspector via a `Map<columnName, FieldState>` ref, and let `InspectorBulkField` notify changes. Pick whichever is cleaner during implementation; document the choice in a code comment.
- [x] 5.10 Render a sticky footer below the inspector body in bulk mode with two buttons:
  - Primary: `Apply to <eligibleRows.length> rows`. Disabled when `touchedCount === 0`.
  - Secondary: `Cancel`. Always enabled in bulk mode.
- [x] 5.11 On Apply: iterate every touched field. For JSON/JSONB fields, run `validateJsonInput(text)`; if any fails, set the field's `jsonError` and abort (do not mutate the buffer, do not reset touched state). For numeric fields, replicate the existing parse-and-fallback logic from `InspectorEditableField`. Build `entries: Array<{ rowKey, column, value, pk, originalRow, originalColumns }>` of cardinality `touchedFields.length × eligibleRows.length`. Call `buffer.bulkSetCellEdit(entries)` once. After success, reset every field to pristine using the just-applied values (so the inspector reflects the new state without remount).
- [x] 5.12 On Cancel: reset every field to pristine (`touched = false`, `text` resets to pristine value, clear errors/warnings). Do NOT clear the selection. Do NOT mutate the buffer.
- [x] 5.13 No-PK relation (`pkColumns === null`) in bulk mode: render a banner `Bulk edit unavailable on relations without a primary key` in place of editable fields. Do NOT render the Apply footer.
- [x] 5.14 Read-only connection in bulk mode: render every field read-only (similar to today's single-row behavior). Do NOT render the Apply footer.
- [x] 5.15 Add an effect that resets all field state when `eligibleRows`' identity changes (e.g. via a memoized cache key like `eligibleRows.map(r => r.rowKey).join(",")`). Selection-range changes therefore discard touched state silently.

## 6. ⌫ for multi-row delete

- [x] 6.1 In `DataGrid.tsx`, change the `Backspace`/`Delete` branch of `onGridKeyDown` to iterate the full `selectedIndices` set (not just `selectedRowIndex`).
- [x] 6.2 For each index, build an entry for `buffer.bulkDeleteToggle`: classify as `insert` (remove from buffer), server-with-PK + not-yet-deleted (mark delete), or already-deleted (unmark). Skip server rows on no-PK relations.
- [x] 6.3 Invoke `buffer.bulkDeleteToggle(entries)` once with the assembled list, so the action is a single undo step.
- [x] 6.4 No-op the action when `isReadOnly` or when the resulting entries array is empty.

## 7. Bottom bar selection chip

- [x] 7.1 In `src/modules/postgres/data/BottomBar.tsx`, accept new props `selectedCount: number` and `onClearSelection: () => void`.
- [x] 7.2 When `selectedCount >= 2`, render a chip `<N> rows selected · Clear` to the left of the dirty-count indicator. Use `background: var(--accent-soft)`, `color: var(--accent)`, `border-radius: var(--radius-full)`, `font-size: 11px`, padding consistent with the rest of the bar.
- [x] 7.3 The `Clear` button calls `onClearSelection`. Hide the chip entirely when `selectedCount < 2`.
- [x] 7.4 Wire the new props from `TableViewerTab.tsx`: `selectedCount` derived from `selection` (`anchor === null ? 0 : Math.abs(active - anchor) + 1`), `onClearSelection` sets `{ anchor: null, active: null }`.

## 8. Styling polish

- [x] 8.1 In `src/modules/postgres/data/DataGrid.module.css`, confirm `.row[data-selected="true"]` already renders `--accent-soft`. If the row-hover transition causes flicker during fast drag, reduce/remove the `transition` on the selected state. Add `cursor: default` rule that activates when bulk-edit mode is on (via a class on the grid root).
- [x] 8.2 In `src/modules/postgres/data/Inspector.module.css`, add styles for: `.fieldTouched` (accent left border, e.g. `border-left: 2px solid var(--accent); padding-left: 6px;`), `.touchedDot` (small accent-colored ●), `.revertButton` (subtle 11px button), `.bulkPlaceholder` (uses `color: var(--muted)` + italic for the `— multiple values —` text), `.bulkFooter` (sticky bottom, `border-top: 1px solid var(--border); background: var(--surface); padding: 8px; display: flex; gap: 8px; justify-content: flex-end;`), `.bulkBanner` (the no-PK banner styling, matching the rest of the bottom-bar banners).
- [x] 8.3 Manual visual pass against `DESIGN.md`: no new borders beyond the accent indicator, no gradients, accent strictly `#A855F7`. Verify the touched-state indicator reads clearly without being noisy.

## 9. Manual QA

- [x] 9.1 Drag-select 5 rows on a small table (< 100 rows), open the inspector bulk mode, touch a `text` column, click Apply, save with `⌘S`, verify all 5 rows updated in the DB via a separate SELECT.
- [x] 9.2 Drag-select 500 rows on a large table (10k+), confirm auto-scroll while dragging. In the inspector bulk mode, touch 3 columns, click Apply, save, verify the dirty-count UI shows 500 and the save succeeds in one transaction.
- [x] 9.3 Bulk-edit an enum column: verify the field shows `(no change)` + enum options; selecting `(no change)` keeps the column untouched; selecting a concrete value sets touched.
- [x] 9.4 Bulk-edit a jsonb column with valid JSON, apply, then with invalid JSON, verify Apply aborts and only the JSON field shows inline error; the other touched fields keep their touched state.
- [x] 9.5 Selection that includes 1 insert row + 9 server rows → inspector reads `Inspector · 9 rows selected`; the Apply button reads `Apply to 9 rows`; the insert row is unaffected after apply.
- [x] 9.6 Common-value column → field shows the common value in pristine; touching and immediately ↺ reverting works.
- [x] 9.7 Touched + empty (after manually deleting all text) → Apply writes NULL to that column across all eligible rows.
- [x] 9.8 Cancel button resets all touched fields to pristine without touching the buffer or the row selection.
- [x] 9.9 `⌫` over a 20-row selection toggles delete on all 20; `⌘Z` once reverts all 20.
- [x] 9.10 `⌫` over a mixed selection (insert + clean + already-deleted) correctly applies the three per-row rules in a single undo step.
- [x] 9.11 Sort change, filter change, and page-size change clear the selection.
- [x] 9.12 Read-only connection: drag still selects rows visually, but `⌫` is no-op and the inspector bulk shows read-only fields with no Apply footer.
- [x] 9.13 No-PK relation (view): selecting 5 rows shows the inspector's `Bulk edit unavailable on relations without a primary key` banner; `⌫` is no-op on server rows.
- [x] 9.14 Inline cell editor is suppressed in bulk mode: double-click on any cell does not open the editor when the effective selection ≥ 2.
- [x] 9.15 Changing the selection range while fields are touched discards the touched state (no confirmation dialog in v1).
- [x] 9.16 Single-row selection (≥1 but effective count = 1, e.g. all but one are filtered out): inspector returns to single-row mode and inline cell editor is re-enabled.

## 10. Validation

- [x] 10.1 `npm run lint` + `npm run typecheck` clean.
- [x] 10.2 `npm test` (vitest) — all existing tests green; new buffer tests for bulk actions green.
- [x] 10.3 `openspec validate add-postgres-multi-row-edit --strict` passes.
