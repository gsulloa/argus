## 1. CSS: suppress native text selection on the grid display path

- [x] 1.1 In `src/modules/postgres/data/DataGrid.module.css`, add `user-select: none;` and `-webkit-user-select: none;` to the `.row` rule (currently at lines ~96–100). Place the declarations immediately after `cursor: pointer;` so the row block stays visually grouped.
- [x] 1.2 In the same file, add `user-select: none;` and `-webkit-user-select: none;` to the `.cell` rule (currently at lines ~125–137). This prevents inheritance edge cases where a cell's child span could otherwise re-enable selection.
- [x] 1.3 Add an explicit override on `.cellEditing` (currently at ~242–245): `user-select: text;` and `-webkit-user-select: text;` so the editor wrapper re-enables text selection.
- [x] 1.4 Add the same `user-select: text;` / `-webkit-user-select: text;` declarations on `.cellEditor` (currently at ~246–257) so the input/textarea/select itself is guaranteed selectable in all engines.
- [x] 1.5 Leave `.headerCell`'s existing `user-select: none;` (line ~49) unchanged.

## 2. DataGrid.tsx: force-select on click and remove toggle-deselect

- [x] 2.1 In `src/modules/postgres/data/DataGrid.tsx`, locate the row `<div>`'s `onMouseDown` handler (around line 395). After the `if (e.button !== 0) return;` guard, add `e.preventDefault();` on the next line. Add a brief inline comment if and only if the reason is non-obvious to a future reader — preferred copy: `// Prevent the browser from starting a native text-selection drag inside the cell.`
- [x] 2.2 In the `handleMouseUp` function inside the drag effect (around lines 237–270), locate the `else` branch that runs when `drag.status !== "active"` (the "click, pending never crossed threshold" branch, currently lines 250–261).
- [x] 2.3 Replace the entire body of that `else` branch with a single unconditional call: `onSelectionChange({ anchor: drag.anchorIndex, active: drag.anchorIndex });`. Remove the `prev`, `isSingleRowSelected` local computations and the toggle-deselect path entirely. Keep the surrounding `dragRef.current = null` / `setDragActive(false)` and the `rootEl?.focus()` line that follows.
- [x] 2.4 Remove the now-unused `prevSelection` field from the `DragState` interface (line ~133) and from the `dragRef.current = { ... }` assignment in the row's `onMouseDown` (line ~398–404). This is a small cleanup that prevents a dead-state field from misleading future readers.
- [x] 2.5 Verify the surrounding code still type-checks: the `DragState` interface no longer needs the `prevSelection` import path. Run `bun run typecheck` (or the project's equivalent — check `package.json` scripts) and resolve any type errors that surface.

## 2b. useTableFilter.ts: memoize normalized `applied` so selection isn't cleared every render

Discovered during manual QA — even after group 2 was complete, single-row and multi-row selections still "deselected by themselves". Root cause: `useTableFilter` runs `normalizePersistedFilter(raw)` on every render, producing a new `applied: FilterModel` reference each time. `TableViewerTab.tsx:200` has a `useEffect` that resets `selection` to `{ anchor: null, active: null }` whenever `applied` (among others) changes. Because `applied` was a fresh object on every render, the effect fired after every state change — including the `setDragActive(true)` triggered by mousedown and the `onSelectionChange(...)` triggered by mouseup — clearing the selection immediately after the user made it.

- [x] 2b.1 In `src/modules/postgres/data/useTableFilter.ts`, import `useMemo` from `react`.
- [x] 2b.2 Replace `const value = normalizePersistedFilter(raw);` with `const value = useMemo(() => normalizePersistedFilter(raw), [raw]);` so the normalized `{ draft, applied }` keeps a stable reference across renders when the underlying persisted record hasn't changed.
- [x] 2b.3 Re-run `bun run typecheck` — passes.
- [x] 2b.4 Re-run `bun run test:run` — all postgres/data-grid suites pass. Pre-existing Dynamo `CacheProvider` flake is unrelated.

## 3. EditableCell.tsx: verify double-click still works under the new mousedown

- [x] 3.1 No code change is required in `src/modules/postgres/data/EditableCell.tsx`. The `onDoubleClick` handler at line 112 stays as-is — `dblclick` events fire independently of `mousedown`'s `defaultPrevented` flag.
- [x] 3.2 Confirm there is no `onClick` or `onMouseDown` handler on the display-path `<div>` in `EditableCell.tsx` that would now need adjustment. If one is added in the future, ensure it does not call `stopPropagation()` for the primary button — the row's mousedown handler MUST still see the event so selection works.

## 4. Manual QA in the running app

- [ ] 4.1 Start the Tauri dev shell (`bun run tauri dev` or the project's equivalent — check `package.json` and `src-tauri/`) and open a Postgres connection that exposes at least one table with text columns.
- [ ] 4.2 Click on a single row in the data grid. Verify the row becomes selected (accent-soft background + left accent stripe) and that no cell text is highlighted by the browser's text-selection.
- [ ] 4.3 Click on the same row a second time. Verify the row remains selected (does NOT deselect).
- [ ] 4.4 Click on a different row. Verify the previous row deselects and the new row becomes the single selected row.
- [ ] 4.5 Mouse-down on a row, drag vertically across 3–5 rows, mouse-up. Verify the full range renders with `data-selected="true"` and that no cell text is highlighted during the drag.
- [ ] 4.6 Try the same drag horizontally only (within a single row, drag left-to-right past 10 cells). Verify no text is highlighted and the row's selection remains the single mousedown row.
- [ ] 4.7 Double-click an editable cell (e.g., a `text` column not in the primary key). Verify the inline editor opens, the text is auto-selected inside the input, and Cmd-A / Cmd-C / Cmd-V work normally inside the input.
- [ ] 4.8 With an inline editor open, click-drag inside the input to select a substring. Verify the input's native text-selection works (the substring is highlighted) and the row's drag-select state machine is NOT engaged.
- [ ] 4.9 Press `Escape` outside the editor. Verify the row selection clears.
- [ ] 4.10 Select 3+ rows by drag, then press `Backspace`. Verify bulk delete still toggles the range as before.
- [ ] 4.11 Change the sort. Verify the selection clears (existing behavior).
- [ ] 4.12 Visual regression check: confirm hover states, accent stripe, dirty-cell warning, deleted-row strikethrough, and insert-row left border all still render correctly. The `user-select: none` rule should have no visual side effect on these.

## 5. Spec sync and change ready for review

- [x] 5.1 Re-run `openspec status --change "fix-grid-selection-and-text-drag"` and confirm all artifacts are `done`.
- [x] 5.2 Re-run `openspec validate fix-grid-selection-and-text-drag` (or the project's equivalent validation command) and resolve any structural lint errors.
- [ ] 5.3 Once user-tested and approved, archive the change with `openspec archive fix-grid-selection-and-text-drag` so the modified `Drag-to-select row range` requirement merges into `openspec/specs/postgres-data-grid/spec.md`.
