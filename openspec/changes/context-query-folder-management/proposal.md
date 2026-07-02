## Why

The `context-query-folders` change shipped folder creation, but two gaps make folders unusable in practice:

1. **Newly created (empty/nested) folders don't appear.** `context_create_query_folder` creates the directory on disk but does not invalidate the registry's cached `ParsedContext` nor emit `context://changed`. The `ContextRegistry::get` path returns the cached parse (`registry.rs:233`), so the branch's immediate `refresh()` reads a stale `query_folders` list. Because creating an *empty* directory does not reliably trigger the filesystem watcher (platform-dependent, esp. macOS FSEvents), the folder never shows until the app is reloaded. (Folders that already contain a query appear, because writing the query *file* does fire the watcher.)
2. **There is no way to move a query into another folder.** `context_rename_query` already supports moving (`from_path` → `to_path` in a different folder), but the per-connection Context Queries branch exposes no affordance for it — moving was a v1 non-goal. Users now need it.

## What Changes

- **Fix folder visibility (backend).** `context_create_query_folder` and `context_delete_query_folder` MUST refresh the connection's parsed context (reparse + update cache) and emit `context://changed` (`kinds` incl. `"query"`) synchronously, so a subsequent `context_list_queries` immediately reflects the new/removed folder — including empty folders.
- **Add query management to the branch.** The per-connection Context Queries branch gains a context menu on query rows with **Move to folder…**, **Rename**, and **Delete**, and on folder nodes with **Delete folder** (empty-only, via `context_delete_query_folder`). "Move to folder…" and "Rename" call `context_rename_query` (move = same slug under a new folder; rename = new slug in the same folder); "Delete" calls `context_delete_query` with a confirmation.
- **Move target picker.** "Move to folder…" opens a small picker listing the available destination folders (root + every folder under `queries/`), excluding the query's current folder.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `context-query-authoring`: tighten the folder create/delete requirement so it MUST refresh the parsed context and emit `context://changed` synchronously (empty folders become immediately observable via `context_list_queries`).
- `context-queries-runner`: the per-connection Context Queries branch gains move/rename/delete for queries and delete-empty-folder, via a row/folder context menu and a move-target picker.

## Impact

- **Backend (Rust)** `packages/app/src-tauri/src/modules/context/`:
  - `registry.rs` — add a public method to reparse a connection's context and emit `context://changed` (reuse the `on_flush` reparse+emit path).
  - `commands.rs` — `context_create_query_folder` / `context_delete_query_folder` take the `ContextRegistry` state and call the refresh-and-emit after the filesystem op.
- **Frontend** `packages/app/src/modules/context/`:
  - `components/ContextQueriesBranch.tsx` (+css) — add a Radix context menu on query rows (Move/Rename/Delete) and folder nodes (Delete folder); a move-target picker dialog; confirm dialog for delete. Reuse `contextApi.renameQuery`/`deleteQuery`/`deleteQueryFolder` (all already exist).
  - No backend command-shape changes on the frontend beyond calling the existing path-based `renameQuery`/`deleteQuery`.
- **No data migration.** Builds on `context-query-folders` (not yet archived) — sequence/land after it.
