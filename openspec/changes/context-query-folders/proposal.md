## Why

Context queries are stored flat: every prefab query lives directly under `<root>/<engine>/queries/` and is identified solely by its `name`. As a folder accumulates queries, the per-connection "Context Queries" branch becomes a long unstructured list with no way to group related queries (e.g. `daily/…`, `reports/…`). Users want to **organize context queries into subfolders**, and create those folders directly from the branch.

## What Changes

- **On-disk layout gains subfolders.** A context query may live at `<root>/<engine>/queries/<subfolder…>/<slug>.<ext>` (+ sibling `.meta.yaml`). The `queries/` tree becomes nested; real directories represent folders (including empty ones).
- **Query identity becomes the relative path** under `queries/` (POSIX, without extension) — e.g. `reports/top-customers`. This allows the same display `name`/slug to exist in different folders. Query models gain `path` and `folder` fields; `name` stays the display name.
- **New backend commands** to manage folders: `context_create_query_folder` and `context_delete_query_folder` (empty-only). The parser reads `queries/` **recursively** and reports folders (including empty ones).
- **Path-keyed query commands.** `context_get_query`, `context_rename_query`, and `context_delete_query` key by relative `path` instead of `name`; `context_rename_query` may target a different folder (rename + move). `context_save_query` accepts an optional `folder` placing the new query under it. `context_list_queries` returns `{ queries, folders }`.
- **The per-connection Context Queries branch renders a folder tree** and gains a `New folder` affordance; `New query` can target the selected folder. Opening/renaming/deleting operate by path.
- Schema-sync and the file watcher already ignore-writes-to / classify `queries/**` correctly — no regression; sync still never clobbers user folders.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `context-query-authoring`: the save/rename/delete commands become subfolder- and path-aware; add commands to create/delete query folders; queries carry a relative path; recursive listing.
- `context-queries-runner`: the per-connection Context Queries branch renders a nested folder tree and supports creating folders and placing new queries into them (added behavior; builds on the branch introduced by `context-queries-per-connection`).

## Impact

- **Backend (Rust)** `packages/app/src-tauri/src/modules/context/`:
  - `parser.rs` — `parse_queries_dir` becomes recursive; compute each query's relative `path`/`folder`; collect folder paths (including empty dirs).
  - `types.rs` — `QueryDoc`/`QueryListItem` gain `path` + `folder`; new folder-list shape.
  - `commands.rs` — `context_save_query` (+`folder`), `context_get_query`/`context_rename_query`/`context_delete_query` (path-keyed), new `context_create_query_folder`/`context_delete_query_folder`, `context_list_queries` returns `{ queries, folders }`; register new commands. Path validation (reject `..`/absolute; slugify segments).
  - `registry.rs`/`sync.rs` — verify `queries/**` classification and sync-skip still hold (no change expected).
- **Frontend** `packages/app/src/modules/context/`:
  - `types.ts` — add `path`/`folder` to `QueryListItem`/`QueryDoc`; new list shape; `LinkedQueryGroup` queries gain `path` (cheap).
  - `api.ts` — update `saveQuery` (folder opt), `getQuery`/`renameQuery`/`deleteQuery` (path), `listQueries` (new shape); add `createQueryFolder`/`deleteQueryFolder`.
  - `hooks.ts` `useContextQueries` — surface folders + queries.
  - `openContextQuery.ts` — fetch by `path`.
  - `components/ContextQueriesBranch.tsx` (+css) — render nested tree; `New folder`; place `New query` into folder; open/rename/delete by path. Wiring in `ConnectionRow.tsx`.
- **Depends on** the `context-queries-per-connection` change (branch is the query surface) — sequence this after it is archived.
- **No data migration**: existing flat queries keep working (path = slug, folder = ""). `.meta.yaml` format unchanged.
