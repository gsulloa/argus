## 1. Backend — folder create/delete refresh + emit

- [x] 1.1 In `src-tauri/src/modules/context/registry.rs`, add a public method (e.g. `refresh_and_notify(&self, conn_id: Uuid, kinds: Vec<&'static str>)`) that resolves the connection's canon + engine, reparses via `load_folder`, replaces the cached `parsed_by_engine` entry, and emits `context://changed` with the given `kinds` — reusing the `on_flush` reparse/emit logic. Handle the not-subscribed/unavailable cases gracefully.
- [x] 1.2 Give `context_create_query_folder` and `context_delete_query_folder` the `registry: State<'_, Arc<ContextRegistry>>` argument; after the successful filesystem op, call `refresh_and_notify(conn_id, vec!["query"])` before returning.
- [x] 1.3 Confirm the Tauri handler registration still resolves (the commands already registered in `lib.rs`); no new command names.
- [x] 1.4 Add/adjust Rust tests: after `context_create_query_folder`, `context_list_queries` returns the new (empty) folder without a watcher flush; after delete, it is gone. Run `cargo test` (context module) and `cargo check`.

## 2. Frontend — branch context menu (move / rename / delete)

- [x] 2.1 In `ContextQueriesBranch.tsx`, wrap each query row in a Radix `ContextMenu` with items: Open, Move to folder…, Rename, Delete. Keep the row's click = Open.
- [x] 2.2 Implement **Move to folder…**: open a picker dialog whose options are `""` (root) + every folder from the branch's `folders` list, excluding the query's current `folder`. On select, call `contextApi.renameQuery(connectionId, query.path, joinPath(dest, slugOf(query.path)))` where `slugOf` = last path segment; then `refresh()`. Surface errors as a toast.
- [x] 2.3 Implement **Rename**: prompt via the shared `NamePromptDialog` (prefilled with current name); compute `to_path = joinPath(query.folder, slugify(newName))` using a small shared slug helper mirroring the backend rule; call `contextApi.renameQuery`; `refresh()`.
- [x] 2.4 Implement **Delete**: show a `ConfirmDialog`; on confirm call `contextApi.deleteQuery(connectionId, query.path)`; `refresh()`.
- [x] 2.5 Add **Delete folder** to folder nodes (context menu or affordance), enabled/attempted only for empty folders; call `contextApi.deleteQueryFolder(connectionId, folder.path)`; surface the backend "not empty" error as a toast; `refresh()`.
- [x] 2.6 Style the context menu, picker, and confirm per `DESIGN.md` (read first); reuse existing dialog/menu components and the branch's styling. Update `ContextQueriesBranch.module.css` as needed.

## 3. Verify

- [x] 3.1 Backend `cargo test` (context) + `cargo check`.
- [x] 3.2 Frontend `pnpm -C packages/app typecheck` and `pnpm -C packages/app test:run`; add tests for move (renameQuery args), rename, delete (confirm), delete-empty-folder, and the move picker excluding the current folder.
- [ ] 3.3 Manual QA in the running app: create an empty nested folder → it appears immediately; move a query into another folder → it relocates; rename and delete a query; delete an empty folder (and confirm a non-empty one is refused); existing flat queries still work.
