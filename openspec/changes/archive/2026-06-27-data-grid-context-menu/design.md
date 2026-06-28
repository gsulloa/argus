## Context

The editable data grid lives in the shared component `packages/app/src/modules/postgres/data/DataGrid.tsx`, consumed by the Postgres, MySQL, and MSSQL data tabs (`TableViewerTab.tsx` in each module). It already has everything the menu needs to invoke:

- **Selection model** — `selection: { anchor, active }` (row range) and `activeCell: { row, col }` are mutually exclusive, owned by the parent `TableViewerTab` and passed in with `onSelectionChange` / `onActiveCellChange`.
- **Edit start** — inline editing is driven by local `editing` state and `setEditing({ rowIndex, col })`, gated by `bulkEditActive`. Per-cell read-only is computed as `cellReadOnly` inside the row map.
- **Delete** — `buffer.bulkDeleteToggle(entries)` toggles delete for a list of rows; the exact entry-building loop already exists in the `Backspace`/`Delete` branch of `onGridKeyDown` (handles insert vs server rows, PK extraction, `currentlyDeleted`).
- **Copy cell** — `copyCellValue(displayValue)` from `platform/grid/cellClipboard.ts`, with the buffer-aware display-value lookup already written in the ⌘C branch.

`@radix-ui/react-context-menu` is already a dependency, and the shell already styles Radix menus (`Sidebar.tsx`, `styles.contextMenu`). There is **no** existing row-TSV copy helper — `cellClipboard.ts` only has single-cell copy/format (row copy is tracked separately as #196).

## Goals / Non-Goals

**Goals:**
- One right-click → all common row/cell actions, matching TablePlus discoverability.
- Zero behavioural divergence: menu items call the same buffer/selection/copy paths the shortcuts already use.
- Correct disabled-with-tooltip semantics for read-only and no-PK states.
- Works across all three editable engines for free by living in the shared `DataGrid`.

**Non-Goals:**
- Read-only result grids (`AdhocResultGrid`, Athena `SimpleTable`, CloudWatch) — different components, copy-only at most; deferred.
- The optional "Duplicate row" action — deferred.
- Reworking the underlying delete/edit/copy mechanics or the PK-blocker (#195) and row-copy (#196) feature work beyond what is needed to wire the menu.

## Decisions

### Decision: Use Radix `react-context-menu`, not a hand-rolled popover
Radix ContextMenu handles the right-click gesture, portalled positioning at the pointer, focus trapping, Escape/outside-click dismissal, and `disabled` item semantics. It is already a dependency and matches the project's existing menu styling tokens. **Alternative considered:** a custom `onContextMenu` + absolutely-positioned `<div>` (as `SavedQueriesPanel` does for its tree). Rejected: the tree menu reimplements positioning/dismissal we'd otherwise get for free, and per-row triggers in a virtualized list are cleaner with Radix's `Trigger asChild`.

### Decision: Wrap each rendered row's trigger; resolve the target in `onContextMenu`
Each virtualized row `<div>` already carries `vi.index` and resolves the clicked column from the nearest `[data-col]` element (mirroring the existing `onMouseDown` logic). On context-menu open we run the same column resolution, then apply the retargeting rule: if the right-clicked row is outside the current `selection` range, set `activeCell` to the clicked cell and clear the range (single-row target); if it is inside the range, leave the selection intact (multi-row target). This reuses the established selection model rather than introducing a separate "context target" state. **Alternative considered:** a single grid-level menu reading a separately-tracked context target (the `SavedQueriesPanel` approach). Rejected to avoid a parallel selection concept and keep "(s)" labelling derived directly from the existing selection.

### Decision: Derive the action set and enabled-state from existing per-cell/row computations
- **Edit cell** enabled ⇔ the same `cellReadOnly` computation used in the row map is false **and** `!bulkEditActive`; on click it calls the same `setEditing(...)`.
- **Delete/Restore row(s)** enabled ⇔ `!isReadOnly` and at least one targeted row is deletable (insert rows always; server rows only when `pkColumns != null`); label flips to "Restore" when every targeted row is already `buffer.isRowDeleted`. On click it builds the entry list with the **exact** loop from the `Backspace` branch and calls `buffer.bulkDeleteToggle`.
- **Copy cell** always enabled; reuses the buffer-aware display-value lookup + `copyCellValue`.
- **Copy row(s)** always enabled; see next decision.

To avoid duplicating the entry-building and copy logic between the keyboard handler and the menu, extract small pure helpers (`buildDeleteEntries(range)`, `resolveCellDisplayValue(rowIndex, colIndex)`) within `DataGrid` and call them from both paths.

### Decision: Add a minimal `copyRowsTsv` helper now (relates to #196)
Row copy has no shared helper yet. Add `copyRowsTsv(rows, columns)` next to `cellClipboard.ts` that joins each row's cells with tabs and rows with newlines, formatting every cell through the existing `formatCellValue`. This keeps "Copy row(s)" functional and self-contained; if/when #196 lands a richer row-copy, both can converge on this helper. **Alternative considered:** disable "Copy row(s)" until #196. Rejected — it's the headline ask of the issue and trivial to satisfy with the existing formatter.

### Decision: Tooltips on disabled items
Radix menu items don't render native `title` tooltips when disabled in all browsers reliably; use the project's existing tooltip token/pattern (or a `title`/`aria-description` on the item label span) to explain *why* an item is disabled ("Grid is read-only", "Requires a primary key", "This cell can't be edited"). Keep copy on the disabled reason short and consistent with `DESIGN.md` voice.

## Risks / Trade-offs

- **Virtualized rows + per-row Radix trigger** → only mounted (visible) rows carry a trigger, which is exactly the set the user can right-click, so no correctness issue; verify the portalled menu isn't clipped by the grid's `overflow: auto` viewport (Radix portals to `body`, mitigating this).
- **Right-click vs drag-select state** → the existing `onMouseDown` drag logic responds only to `e.button === 0`; right-click (button 2) won't start a drag, so the two gestures don't conflict. Verify no `mouseup` left dangling.
- **Selection retargeting surprises** → retargeting on right-click-outside matches TablePlus/finder behaviour and is covered by spec scenarios; right-click-inside preserving the multi-selection is the case users rely on for bulk delete.
- **Behavioural drift between shortcut and menu** → mitigated by extracting shared helpers so both paths call identical code; covered by spec "matches Cmd+C / Backspace / double-click" scenarios.

## Open Questions

- Should "Copy row(s)" include a header row in the TSV? Default: **no header** (matches existing single-cell/row-range copy expectations); revisit if QA prefers headers.
- Keyboard access to the menu (Shift+F10 / context-menu key) — Radix supports it on a focused trigger; nice-to-have, not required by the acceptance criteria.
