## Why

The per-connection Context Queries branch now lets users move a query via a context-menu → "Move to folder…" picker, but users expect to **drag a query onto a folder** to move it — the natural gesture for a file-tree, and the same interaction the global Saved Queries panel already supports. The context-menu picker also currently surfaces a backend error in some cases (e.g. choosing a destination that resolves to the query's current path), which must be fixed so any move path — drag or menu — works reliably.

## What Changes

- **Drag-and-drop move in the Context Queries branch.** Query rows become draggable; folder nodes (and the branch root) become drop targets. Dropping a query onto a folder moves it there via `context_rename_query` (keeping the query's slug under the new folder). A visual drop indicator highlights the target folder while dragging; dropping onto the root moves the query to the top level.
- **Fix the underlying move so it never errors on a no-op or same-target.** A move whose destination equals the query's current folder is a no-op (no backend call, no error). Guard both the drag path and the existing "Move to folder…" menu against producing a `to_path` equal to `from_path`.
- **Keep the context menu.** "Move to folder…", Rename, and Delete remain available in the row context menu; drag-and-drop is added as the primary, discoverable gesture.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `context-queries-runner`: the per-connection Context Queries branch supports moving a query by dragging it onto a folder (or the root); moves that would be a no-op are ignored rather than erroring.

## Impact

- **Frontend** `packages/app/src/modules/context/components/ContextQueriesBranch.tsx` (+css):
  - Make query rows `draggable`; add drag start carrying the query `path`.
  - Make folder rows and the branch root drop targets (`onDragOver`/`onDrop`), with a highlight class while a valid drag hovers.
  - On drop, compute `to_path = join(destFolder, slugOf(query.path))`; if unchanged, do nothing; else call `contextApi.renameQuery` and `refresh()`; surface errors as a toast.
  - Auto-expand a collapsed folder that receives a drop so the moved query is visible.
  - Guard the existing "Move to folder…" handler against no-op moves too.
- **Reference**: the global Saved Queries panel's `SidebarTree` DnD (`enableDnd`/`onDndDrop`) as the interaction model; the branch uses a custom recursive renderer, so this is HTML5 drag-and-drop on the rows.
- **No backend command changes** — `context_rename_query` already supports cross-folder moves; only the client stops issuing no-op renames.
- Builds on `context-query-folders` / `context-query-folder-management` (unarchived) — sequence after them.
