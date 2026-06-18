## Context

Each engine's table viewer renders an inspector panel that shows the full detail of the selected row. The visibility model differs by engine:

- **Postgres** (`postgres/data/TableViewerTab.tsx`): the inspector is **permanently docked** — there is no `inspectorVisible` state and no hide toggle. It is only horizontally resizable. It cannot be the source of the reported problem.
- **MySQL** (`mysql/data/TableViewerTab.tsx:161`) and **MSSQL** (`mssql/data/TableViewerTab.tsx:220`): the inspector is gated by a local `const [inspectorVisible, setInspectorVisible] = useState(true)` boolean, toggled by an `Inspector` toolbar button (mysql `:449`, mssql `:546`). When toggled off, `{inspectorVisible && <Inspector .../>}` (mysql `:671`, mssql `:766`) removes the panel entirely. This is where the reported problem lives: a row click selects the cell but the hidden panel stays hidden.
- **DynamoDB** (`dynamo/data-view/DataViewTab.tsx`): the inspector is a resizable dock that is always present; the `dynamo-data-view` spec already requires selection/complex-cell clicks to "select the row and focus the inspector". It already follows selection.

The grid components already expose the exact hook we need. In `mysql/data/DataGrid.tsx` and `mssql/data/DataGrid.tsx`, `onCellClick` calls `onCellSelect?.(rowIdx, colIdx)` (mysql `:188`, mssql `:190`) at the end of both the plain-click and shift-click branches, and the double-click edit-start path also calls it (mysql `:427`, mssql `:429`). Critically, `onCellSelect` is **not** invoked by header sort clicks, the resize handle, scroll, or any toolbar button — those have separate handlers. The parent currently passes a no-op `onCellSelect` (mysql `:664`, mssql `:759`).

## Goals / Non-Goals

**Goals:**
- Clicking a row in the MySQL/MSSQL grid while the inspector is hidden auto-reveals it and shows that row.
- Clicking another row while the inspector is already open updates it without closing it.
- Header sort, filters, resize, scroll, and toolbar actions never open the inspector.
- Multi-row (shift-click) selection keeps working and still reveals the inspector in its range mode.
- Inline editing is never interrupted by the reveal.

**Non-Goals:**
- No change to Postgres (inspector is non-hideable) or DynamoDB (already follows selection).
- Not persisting a new inspector-visibility default; the auto-reveal flips in-memory state only and the manual toggle is unchanged.
- Not adding a new keyboard shortcut, command, or grid-level event.
- No backend/Tauri changes.

## Decisions

**Decision: Reveal in the parent's `onCellSelect` handler, not inside the grid.**
The grid already centralizes "a cell/row was selected by the user" in the `onCellSelect` callback, and the parent owns `inspectorVisible`. Replace the no-op handler with one that calls `setInspectorVisible(true)`. Rationale: keeps visibility state where it lives, requires zero grid changes, and inherits the grid's existing gesture filtering (sort/resize/scroll/toolbar don't fire `onCellSelect`).

- _Alternative considered — flip visibility inside `DataGrid.onCellClick`:_ rejected; the grid would need a new prop and would own UI-chrome state that belongs to the parent.
- _Alternative considered — a `useEffect` on the derived `selectedRows`/`activeCell`:_ rejected; an effect would also fire on programmatic selection changes (e.g. selection restored after a refetch) and could re-open a panel the user just closed without clicking. The callback fires only on a real user click.

**Decision: Reveal on both plain-click and shift-click; do not try to suppress shift-click.**
`onCellSelect` fires for both branches. Shift-click extends a multi-row range — still an inspection gesture — so revealing is correct (the inspector renders its multi-row mode). No branching needed.

**Decision: `setInspectorVisible(true)` is idempotent and edit-safe.**
Setting it true when already true is a no-op (React bails on identical state). The double-click edit-start path also calls `onCellSelect`, so editing inside a hidden inspector reveals it too — acceptable and harmless; flipping a sibling boolean does not unmount or reset the editor, which lives in the grid.

## Risks / Trade-offs

- **[A user who deliberately hid the inspector finds it reappears on the next click]** → This is the intended behavior per the issue; the toggle remains available to hide it again. We deliberately do not persist a "stay hidden" preference.
- **[`onCellSelect` also fires on double-click edit-start, revealing the panel mid-edit]** → Harmless: the reveal only toggles a boolean; the inline editor is unaffected and the inspector reflects the buffer's dirty state, which is consistent with existing behavior.
- **[Divergence between MySQL and MSSQL implementations]** → Mitigated by applying the identical one-line change in both parents and adding parallel scenarios to both specs.

## Migration Plan

No data or persistence migration. Pure in-memory UI behavior; ships in a single frontend change and is trivially revertible by restoring the no-op `onCellSelect` handlers.

## Open Questions

None.
