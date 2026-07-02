## 1. No-op move guard (fixes the current move error)

- [x] 1.1 In `ContextQueriesBranch.tsx`, add a helper that computes `to_path = joinPath(dest, slugOf(query.path))` and returns early (no `renameQuery`, no toast) when `to_path === query.path`.
- [x] 1.2 Apply the guard in `handleMove` (the context-menu "Move to folder…" path) so choosing the current folder / root-of-a-root-query no longer surfaces the backend "already exists" error.

## 2. Drag-and-drop to move

- [x] 2.1 Make each query row `draggable`; on `dragStart` set `effectAllowed = "move"`, put the query `path` on `dataTransfer`, and store the dragged query in component state (source of truth). Clear it on `dragEnd`.
- [x] 2.2 Make folder rows drop targets: `onDragOver` → `preventDefault()` + set `dragOverPath` (for highlight); `onDragLeave` → clear; `onDrop` → resolve dragged query, compute `to_path` for that folder, apply the no-op guard, else `contextApi.renameQuery(connectionId, from, to)` then `refresh()`; toast on backend error. `stopPropagation` so events don't bubble into any outer sidebar DnD.
- [x] 2.3 Add a branch **root drop zone** (e.g. the branch body / header area) so a query can be moved to the top level (`dest = ""`). Same guard + move logic.
- [x] 2.4 On a successful drop into a folder, add that folder path to `expandedFolders` so the moved query is visible immediately.
- [x] 2.5 Show a drop-target highlight on the hovered folder (reuse/extend `folderRowTarget`); clear on drop/leave/dragend. Style per `DESIGN.md` (read first); update `ContextQueriesBranch.module.css`.

## 3. Verify

- [x] 3.1 `pnpm -C packages/app typecheck`.
- [x] 3.2 `pnpm -C packages/app test:run`; add tests: drag a root query onto a folder calls `renameQuery` with expected `from`/`to`; drop onto current folder is a no-op (no `renameQuery` call); drop onto root moves to top level; menu "Move to folder…" onto current folder is a no-op. Keep existing branch tests green.
- [ ] 3.3 Manual QA in the running app: drag a query onto a folder → it moves and the folder auto-expands; drag it back to root → moves to top level; dropping on its own folder does nothing (no error toast); the connection rail's own drag still works; context-menu move/rename/delete still work.
