## 1. Fix

- [x] 1.1 In `packages/app/src/modules/postgres/data/EditableCell.tsx`, add `onMouseDown={(e) => e.stopPropagation()}` to the edit-path wrapper `<div className={`${styles.cell} ${styles.cellEditing}`}>` (the branch returned when `editing` is true, ~line 146) so a mousedown inside the active editor never reaches the row drag-select handler.
- [x] 1.2 Confirm no change is needed in `DataGrid.tsx` — the row `onMouseDown` (line 650) and the `dragActive` effect (line 360) stay as-is; stopping propagation at the wrapper prevents drag arming and the `handleMouseUp` focus-steal.

## 2. Tests

- [x] 2.1 In `packages/app/src/modules/postgres/data/__tests__/`, add a test: enter edit mode on a `text` cell (double-click), then fire a `mousedown` inside the editor input; assert the `<input>` is still rendered (edit mode retained), the editor kept focus, and `onCommitEdit` was NOT called.
- [x] 2.2 Add a test asserting the in-editor `mousedown` does not toggle row selection (`data-selected` / selection state unchanged) — i.e. the row drag-select machinery is not engaged.
- [x] 2.3 Verify existing tests still pass: double-click-to-edit, single-click row selection, drag-to-select on display cells, Enter/Tab/blur-outside commit, Escape cancel, NULL toggle.

## 3. Verify

- [ ] 3.1 Run the app against a Postgres connection, double-click an editable `text` cell, then click inside the text — confirm the caret moves to the click point and edit mode stays open (issue #246 reproduction no longer occurs).
- [ ] 3.2 Confirm click-drag inside the editor selects a substring without highlighting other cells or selecting rows, and that clicking a different cell still commits the open editor.
- [x] 3.3 Run `pnpm --filter argus test:run` and `pnpm --filter argus lint` / `typecheck` for the app package; ensure green. (1631+2 new tests pass; typecheck clean; lint 0 errors — 91 pre-existing warnings unrelated to this change.)
