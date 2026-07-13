## Context

The Postgres data grid (`packages/app/src/modules/postgres/data/`) renders a virtualized, editable table. Two interaction systems overlap on the same DOM subtree:

1. **Row drag-to-select** — each virtualized row `<div>` has an `onMouseDown` handler (`DataGrid.tsx:650`) that, for any primary-button press, calls `e.preventDefault()` and arms a drag state machine via `setDragActive(true)`. Arming installs `document`-level `mousemove` / `mouseup` listeners (gated by the `dragActive` effect at `DataGrid.tsx:360`). On mouse-up, `handleMouseUp` (`DataGrid.tsx:400`) finalizes selection and **focuses the grid root** (`rootEl?.focus()`, line 421) so keyboard shortcuts work after a click.

2. **Inline cell editor** — double-click renders `<CellEditor>` inside a `.cellEditing` wrapper (`EditableCell.tsx:146`). The editor input auto-focuses and auto-selects its text on mount (`EditableCell.tsx:217-223`) and commits on `onBlur` (`EditableCell.tsx:403`), which calls `onCommitEdit → setEditing(null)`.

The editor input is a DOM descendant of the row `<div>`, and nothing stops the mousedown from bubbling. So when the user clicks inside the active editor to reposition the caret, the row handler fires: `preventDefault()` suppresses native caret placement, and arming the drag installs the mouseup listener that then steals focus to the grid root — blurring the editor, firing `commit`, and exiting edit mode. This is issue #246.

The existing `.cellEditing` wrapper and `.cellEditor` input already re-enable `user-select: text` (per the current spec), and the NULL-toggle button already guards itself with `onMouseDown={(e) => e.preventDefault()}` for the same class of problem. What is missing is isolating the *whole editor subtree* from the row's mousedown.

## Goals / Non-Goals

**Goals:**
- A mousedown inside the active inline editor must not arm the row drag-select machinery, so clicking inside the editor text repositions the caret and click-dragging selects a substring — both without exiting edit mode or stealing focus.
- Keep the fix minimal and local to the editor component; no behavioural change to `DataGrid.tsx`.
- Preserve all existing behaviour: double-click-to-edit, single-click row selection, drag-to-select on display cells, commit on Enter/Tab/blur-outside, cancel on Escape, NULL toggle.

**Non-Goals:**
- No change to MySQL, MSSQL, or DynamoDB grids (MySQL/MSSQL have no row-level mousedown drag-select and don't exhibit the bug; DynamoDB already stops propagation on its editor).
- No change to commit-on-blur semantics: clicking *outside* the editor (elsewhere in the grid) still commits, as today.
- No new design tokens, CSS layout changes, or backend changes.

## Decisions

### Decision: Stop `mousedown` propagation at the `.cellEditing` wrapper

Add `onMouseDown={(e) => e.stopPropagation()}` to the edit-path wrapper `<div className={styles.cellEditing}>` in `EditableCell.tsx:146`.

Rationale:
- Because the mousedown never reaches the row handler, `preventDefault()` is never called on it — so the browser performs its native caret placement / text-selection inside the input. The click positions the caret exactly where expected.
- Because the row handler never runs, `setDragActive(true)` is never called, the `document` mouseup listener is never installed, and `handleMouseUp`'s `rootEl?.focus()` never fires — the editor keeps focus, so no blur, no commit, no exit.
- `stopPropagation` (not `preventDefault`) is deliberate: we want to suppress the *ancestor* row handler while keeping the input's own default behaviour intact.
- This mirrors the pattern the DynamoDB grid already uses on its inline editor (`TabView.tsx` `onMouseDown={(e) => e.stopPropagation()}`) and satisfies the existing spec prose that already assumes "the editor's stopPropagation … keeps the row mousedown handler inert."

**Alternative considered — guard inside the row handler** (`if (editing && (e.target).closest("." + styles.cellEditing)) return;` at `DataGrid.tsx:650`). Rejected as the primary approach: it spreads editor-awareness into the grid, requires the grid to know the editor's class, and must be duplicated for every editor variant/engine. Stopping at the editor wrapper keeps the concern where the editor lives. (The wrapper approach is strictly sufficient because the wrapper encloses every editor variant — input, textarea, select, and the NULL-toggle row.)

### Decision: Place the guard on the wrapper, not each input

The `.cellEditing` div wraps every editor variant (`<input>`, `<textarea>`, `<select>`, and the `cellEditorRow` containing the NULL toggle). A single `onMouseDown` on the wrapper covers all of them and any padding around the input, so a mousedown anywhere in the editing cell is isolated. This avoids repeating the handler on each of the three input variants inside `CellEditor`.

## Risks / Trade-offs

- **[Risk] Stopping mousedown propagation could also block a handler on the grid root or an ancestor that legitimately needs the editing-cell mousedown.]** → The only ancestor mousedown handlers are the row drag-select handler and the gutter-cell handler; both should be inert during editing by design. The grid root's keyboard handling relies on focus, not mousedown, and the editor retains focus. No legitimate ancestor behaviour is lost.
- **[Risk] Commit-on-click-outside might be affected.]** → No. Clicking outside the `.cellEditing` wrapper (another cell, the gutter, empty space) is unchanged — those mousedowns still reach their handlers and still blur → commit the editor as today. Only in-editor mousedowns are isolated.
- **[Risk] `<select>` dropdowns (boolean/enum editors) behave oddly.]** → `stopPropagation` does not `preventDefault`, so the native select still opens on click. Verified by reasoning; covered by keeping the guard on the wrapper rather than the input.
- **[Trade-off] The row's drag-to-select cannot be initiated by pressing down inside an actively-editing cell.]** → Intended: while a cell is being edited, an in-cell press is an editing gesture, not a row-selection gesture. To start a row drag, the user presses on a non-editing cell (which also commits the open editor via blur), consistent with existing expectations.
