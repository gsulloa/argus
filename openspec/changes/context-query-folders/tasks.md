## 1. Backend — model & recursive parser

- [x] 1.1 In `src-tauri/src/modules/context/types.rs`, add `path: String` (relative POSIX under `queries/`, no ext) and `folder: String` (parent dir, `""` at root) to `QueryDoc` and `QueryListItem`. Keep `name`/`description`/`params`/`tags`. Ensure serde field names match the TS side (camelCase as used elsewhere).
- [x] 1.2 In `parser.rs`, make `parse_queries_dir` **recursive**: walk subdirectories under `queries/` (skip dotfiles/symlinks), pair `<stem>.<ext>` bodies with `<stem>.meta.yaml`, and compute each query's `path`/`folder` relative to `queries/` (POSIX). Also collect the set of all subfolder paths (including empty dirs) and return it alongside the queries.
- [x] 1.3 Thread the folder list through `load_folder`/`ParsedContext` so it is available to the list command.
- [x] 1.4 Add a shared path-validation/normalization helper: reject absolute paths and any `..` segment; normalize each segment with the existing `slug_for_query_name` rule; return the safe relative `PathBuf` + POSIX string. Unit-test it (traversal attempts, empty, nested).

## 2. Backend — commands

- [x] 2.1 `context_save_query`: add optional `folder` param; validate it; target `queries/<folder>/<slug>.<ext>` (+ meta), `create_dir_all` intermediates; conflict check per full relative path; return `QueryDoc` with `path`/`folder`.
- [x] 2.2 `context_get_query`: key by `path` (relative) instead of `name`; resolve and return the `QueryDoc`.
- [x] 2.3 `context_rename_query`: change args to `{ connection_id, from_path, to_path }`; support move across folders (create intermediates), update meta `name`; `Conflict` if `to_path` exists, `NotFound` if `from_path` missing, reject unsafe paths.
- [x] 2.4 `context_delete_query`: key by `path`; remove body + meta; `NotFound` if absent; reject unsafe paths.
- [x] 2.5 Add `context_create_query_folder({ connection_id, path })` (idempotent `create_dir_all`, validated) and `context_delete_query_folder({ connection_id, path })` (empty-only; error on non-empty; `NotFound` if absent). Emit `context://changed` (`kinds` incl. `"query"`) after each.
- [x] 2.6 `context_list_queries`: return `{ queries, folders }` (queries carry `path`/`folder`; `folders` = all subfolder paths incl. empty).
- [x] 2.7 `context_list_linked_queries`: include `path` on each query item (type consistency; no behavior change).
- [x] 2.8 Register the two new commands in the Tauri invoke handler; keep existing command names otherwise stable.
- [x] 2.9 Verify `registry.rs::classify_path` tags `queries/**` (incl. subfolders) as `"query"` and `sync.rs` still skips `queries/` — add/adjust tests if needed. No clobbering of user folders.

## 3. Frontend — types, api, hooks

- [x] 3.1 In `src/modules/context/types.ts`, add `path`/`folder` to `QueryListItem` and `QueryDoc`; change the `listQueries` return type to `{ queries: QueryListItem[]; folders: string[] }`; add `path` to `LinkedQueryGroup` query items.
- [x] 3.2 In `src/modules/context/api.ts`: `saveQuery` gains `folder?` in opts (pass through); `getQuery(connectionId, path)`; `renameQuery(connectionId, fromPath, toPath)`; `deleteQuery(connectionId, path)`; `listQueries` returns the new shape; add `createQueryFolder(connectionId, path)` and `deleteQueryFolder(connectionId, path)`.
- [x] 3.3 Update `useContextQueries` (`hooks.ts`) to expose `{ queries, folders }` (keep the `context://changed` refresh).
- [x] 3.4 Update `openContextQuery.ts` to fetch by `path` (use `query.path`).

## 4. Frontend — Context Queries branch tree

- [x] 4.1 In `ContextQueriesBranch.tsx`, build a nested tree from `{ queries, folders }` (folders before queries per level, case-insensitive sort; include empty folders) and render it (reuse `<SidebarTree/>` or a small recursive renderer). Preserve loading/error/empty and the setup CTA.
- [x] 4.2 Add a `New folder` affordance (uses the shared `NamePromptDialog`) calling `contextApi.createQueryFolder`; when a folder node is targeted, nest under it, else root.
- [x] 4.3 Make `New query` folder-aware: when a folder is targeted, pass `folder` to the create handler; thread this through `ConnectionRow.tsx`'s `onNewQuery` (accept an optional target folder).
- [x] 4.4 Open/rename/delete operate by `path`; update the branch handlers and any wiring in `ConnectionRow.tsx` accordingly. Optionally offer empty-folder delete via `deleteQueryFolder`.
- [x] 4.5 Style folder nodes/affordances per `DESIGN.md` (read first); keep compact and consistent with the branch. Update `ContextQueriesBranch.module.css`.

## 5. Verify

- [x] 5.1 Backend: `cargo test` in `src-tauri` (parser recursion, path validation, save-into-folder, rename/move, delete, create/delete folder). Resolve failures.
- [x] 5.2 Frontend: `pnpm -C packages/app typecheck` and `pnpm -C packages/app test:run`; update/add tests for the tree rendering, New folder, folder-targeted New query, and path-based open/rename/delete.
- [ ] 5.3 Manual QA in the running app: create a folder in a connection's Context Queries branch, create a query inside it (verify it lands at `queries/<folder>/…` on disk and opens), nest folders, same-named queries in two folders coexist, empty folder shows and can be removed; existing flat queries still render and open.
