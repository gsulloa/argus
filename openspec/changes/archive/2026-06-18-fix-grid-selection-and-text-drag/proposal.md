## Why

Row selection in the Postgres data grid is broken in practice: dragging in the grid triggers the browser's native text-selection (highlighting cell contents) instead of the drag-to-select-rows behavior, and clicking a single row appears to "deselect itself" because of an unwanted toggle-deselect rule that fires on every single click against an already-selected row. The grid is the primary surface for inspecting and bulk-editing data; if neither single nor multi-row selection works reliably, the entire bulk edit / bulk delete flow is unreachable. The intended interaction model is simple and must be enforced: **single click always selects the row, drag always extends a row range, only double-click enters cell edit mode, and the grid never enters native text-selection mode.**

## What Changes

- **Force row selection on single click.** A primary-button mousedown on a row body cell ALWAYS sets the selection to `{ anchor: rowIndex, active: rowIndex }`, with no toggle-deselect behavior. Clicking the same row again is a no-op (still selected); clicking a different row replaces the selection.
- **Remove toggle-deselect-on-click.** The previous rule — "click an already-selected single row to deselect" — is removed. Deselection happens only via `Escape`, the `Clear` chip in the bottom bar, or implicit clears (sort/filter/page-size change).
- **Suppress native text selection in the grid body.** Apply `user-select: none` to `.row` and `.cell` (display path), and call `e.preventDefault()` on the row's mousedown so the browser does not start a text-selection drag. The inline cell editor (input/textarea/select) MUST remain text-selectable; only the read-only display path is locked.
- **Only double-click enters edit mode.** Reaffirm and harden the existing rule: a single click on a cell never enters inline edit; only `onDoubleClick` on an editable cell calls `onStartEdit`. The double-click MUST still work after the `user-select: none` and `preventDefault` changes.
- **BREAKING (user-visible)**: clicking a selected row no longer deselects it. Users who relied on this must press `Escape` or use `Clear` instead.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `postgres-data-grid`: the `Drag-to-select row range` requirement changes — single-click semantics shift from "toggle" to "force-select", and the requirement gains explicit clauses on suppressing native text selection during drag and on the double-click-only edit-entry rule (the latter is currently implicit in cell rendering but not codified in the selection requirement).

## Impact

- **Code:**
  - `src/modules/postgres/data/DataGrid.tsx` — row `onMouseDown` handler (preventDefault, drop toggle-deselect branch in mouseup handler).
  - `src/modules/postgres/data/DataGrid.module.css` — add `user-select: none` to `.row` / `.cell`; ensure `.cellEditing` and `.cellEditor` re-enable `user-select: text` so the editor remains selectable.
  - `src/modules/postgres/data/EditableCell.tsx` — verify `onDoubleClick` still fires under the new mousedown behavior; no functional change expected, but the harness around it is touched.
- **Specs:** `openspec/specs/postgres-data-grid/spec.md` — `Drag-to-select row range` requirement updated; one scenario removed (`#### Scenario: Clicking the same row again deselects it` if present) and replaced with `#### Scenario: Clicking the same row again is a no-op`; new scenarios added for text-selection suppression and double-click edit entry.
- **Tests / QA:** manual QA in the Postgres data grid (no automated test harness for mouse drag exists today). Must verify: single click selects; dragging selects a range without highlighting text; double-click on an editable cell still opens the inline editor; `Escape` clears selection; bulk delete (`Backspace`) still operates on the range.
- **No backend, no API, no migrations.**
- **No dependency changes.**
