## Context

`ContextQueriesBranch.tsx` renders a custom recursive tree (`QueryTree`) of folder nodes and query rows, with a context menu offering Move/Rename/Delete and a `MoveToFolderDialog`. Move already works through `handleMove(query, dest)` → `contextApi.renameQuery(connectionId, query.path, joinPath(dest, slugOf(query.path)))`. The backend `context_rename_query` supports cross-folder moves (creates intermediate dirs) and rejects a destination that already exists with `Validation("query … already exists")` — which is exactly what a no-op move (dest === current folder) triggers, surfacing an error toast. The global Saved Queries panel uses `SidebarTree`'s built-in DnD (`enableDnd`/`onDndDrop`), but the branch is a bespoke renderer, so DnD here is native HTML5 drag-and-drop on the rows.

## Goals / Non-Goals

**Goals:**
- Drag a query row onto a folder (or the root) to move it, with a visible drop highlight.
- Never error on a no-op move (dropping onto the current folder / picking the current folder in the menu).
- Keep the existing context-menu move/rename/delete.

**Non-Goals:**
- No reordering of queries within a folder (only reparenting/move).
- No dragging of folders themselves (move whole subtrees) — follow-up.
- No backend changes; `context_rename_query` already moves.
- No drag between different connections' branches.

## Decisions

**Decision: Pointer-based DnD via `@dnd-kit/core` on the custom rows.**
Query rows are `useDraggable` (id `q:<path>`, `data.query`); folder rows are `useDroppable` (id `f:<path>`, `data.dest = path`); the branch body is a root `useDroppable` (id `root`, `data.dest = ""`). A `DndContext` at the branch level wires `onDragStart`/`onDragOver`/`onDragEnd` (+ a `PointerSensor` with `activationConstraint.distance = 5` so row clicks still open the query, and `pointerWithin` collision detection so an inner folder wins over the overlapping root zone). On drag end we read `active.data.query` + `over.data.dest`, compute the target, and move.
- **Why not native HTML5 DnD (the original plan):** the Tauri webview's built-in drag-drop handler swallows the HTML5 `drop` event, so `onDrop` never fires in the DOM — drag looked fine but drop did nothing. Rather than globally disabling Tauri's native handler (a broad, app-wide change), we mirror the mechanism the global `SidebarTree` already uses successfully in this same webview: `@dnd-kit` (pointer events), which is unaffected.
- Alternative considered: swap the branch to `SidebarTree` wholesale to reuse its DnD. Rejected — larger refactor that would also absorb the branch's setup CTA / New-query affordances; out of proportion for adding one gesture. We reuse only the DnD primitives.

**Decision: Compute target and short-circuit no-ops on the client.**
`to_path = joinPath(destFolder, slugOf(query.path))`. If `destFolder === query.folder` (equivalently `to_path === query.path`), do nothing. Otherwise call `renameQuery` and `refresh()`. Apply the same guard inside `handleMove` (menu path) so the "already exists" error stops appearing. This fixes the reported move error without touching the backend.
- The backend still guards real collisions (moving onto a different query that already occupies `to_path`) → surface that as a toast.

**Decision: Auto-expand the destination folder on drop.**
Add the destination folder path to `expandedFolders` on a successful drop so the moved query is immediately visible (otherwise it "disappears" into a collapsed folder). Root drops need no expansion.

**Decision: Drop-target highlight via a `dragOverPath` state.**
Track the folder path currently hovered; apply a highlight class (reuse/extend `folderRowTarget` styling per `DESIGN.md`). Clear on drop/leave/dragend.

## Risks / Trade-offs

- **[Nested DnD conflicts with the connection sidebar]** → scope drag sources/targets to the branch's own rows; call `stopPropagation` on the branch's drag events so they don't bubble into any outer sidebar DnD. Verify the connection rail's drag still works.
- **[dataTransfer readability]** → keep the dragged query in component state as the source of truth; `dataTransfer` is a fallback/hint. Clear state on `onDragEnd`.
- **[Accidental moves]** → require dropping specifically on a folder/root target; a drop elsewhere is ignored. No confirmation (moves are cheap and reversible by dragging back).
- **[Touch/trackpad]** → HTML5 DnD works with trackpad drag; no touch-specific handling needed for the desktop app.

## Migration Plan

Frontend-only; no migration. Builds on the unarchived folder changes — land after them. Rollback removes the drag handlers and the no-op guard.
