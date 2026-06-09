## 1. Shared save-shortcut helper

- [x] 1.1 Add a `useSaveShortcut({ active, rootRef, onSave })` hook (e.g. under `src/modules/shared/` or the existing shared hooks location) that registers a `window` `keydown` listener gated on `active`, and on `⌘S`/`Ctrl+S` calls `preventDefault()` + `onSave()` when focus is `null`/`document.body` or within `rootRef`, EXCEPT when focus is inside a `.cm-editor`. Clean up the listener on unmount / when `active` flips.
- [x] 1.2 Unit-test the focus rule: fires when nothing is focused, fires when focus is within root, skips when focus is in `.cm-editor`, skips when tab inactive.

## 2. Postgres viewer

- [x] 2.1 In `src/modules/postgres/data/TableViewerTab.tsx` (~L473–563), replace the inline `window` keydown effect's `⌘S` branch with `useSaveShortcut` (or adjust the existing focus guard to allow `document.body`/no-focus), so the save fires when focus is outside the grid. Keep `onSave`'s clean-buffer and read-only no-ops unchanged.
- [x] 2.2 Verify other branches of the existing keydown effect (if any) are preserved or migrated correctly.

## 3. MySQL viewer

- [x] 3.1 In `src/modules/mysql/data/TableViewerTab.tsx` (~L318–365), remove the `⌘S` branch from the root-`div` `handleKeyDown` and wire `useSaveShortcut({ active, rootRef, onSave: handleApply })`. Keep `⌫` delete, `⌘Z` undo, and `⌘R` reload on the `div` handler.
- [x] 3.2 Ensure a `rootRef` exists on the root `div` (add if missing) and that `active` gates the listener.

## 4. MSSQL viewer

- [x] 4.1 In `src/modules/mssql/data/TableViewerTab.tsx` (~L356–407), apply the same change as MySQL: move `⌘S` to `useSaveShortcut({ active, rootRef, onSave: handleApply })`, keep the focus-scoped keys on the `div` handler.
- [x] 4.2 Ensure `rootRef` + `active` gating are in place.

## 5. DynamoDB viewer

- [x] 5.1 In `src/modules/dynamo/data-view/edit/InlineCellEditor.tsx`, extend the `SEditor` and `NEditor` `handleKeyDown` so `(metaKey||ctrlKey) && key === "s"` is treated like `Enter`/`Tab` (preventDefault + commit/tryCommit). Leave `BOOL`/`NULL` as-is.
- [x] 5.2 Confirm the inspector JSON editor's existing `⌘S` → Save still works (untouched — no new global listener added).
- [x] 5.3 Confirm `⌘S` is inert when no inline editor is open and on read-only connections (editing affordances already hidden, so no editor mounts).

## 6. Verification

- [x] 6.1 Manually verify per engine (PG/MySQL/MSSQL): make a dirty edit, click empty space so nothing is focused, press `⌘S` → edits save; with a clean buffer `⌘S` is a no-op; read-only connections do not save.
- [x] 6.2 Manually verify DynamoDB: open an inline cell editor, change the value, press `⌘S` → cell commits (one `update_item`); inspector editor `⌘S` saves; `⌘S` with nothing being edited is a no-op.
- [x] 6.3 Run `npm run lint` / typecheck and the relevant test suites; fix any regressions.
