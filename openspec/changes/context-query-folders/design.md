## Context

Context queries live at `<root>/<engine>/queries/<slug>.<ext>` (+ `<slug>.meta.yaml`), flat. The parser `parse_queries_dir` (`src-tauri/.../context/parser.rs:186`) reads only top-level files (`path.is_file()` → skip dirs). Queries are identified by `name`/slug (`slug_for_query_name`, `commands.rs:813`). `QueryDoc`/`QueryListItem` carry no path. `context_save_query`/`get`/`rename`/`delete` key by name. The file watcher's `classify_path` already tags anything containing a `queries` component as `"query"` (works for subfolders), and schema-sync (`sync.rs`) already skips `queries/` — so nesting won't be clobbered and change events already fire for subfolders. The per-connection branch (`ContextQueriesBranch.tsx`, from the `context-queries-per-connection` change) renders a flat sorted list and now hosts `New query` + a setup CTA.

## Goals / Non-Goals

**Goals:**
- Nested subfolders under `queries/`, including empty folders.
- Query identity by relative path so identical names can coexist in different folders.
- Create/delete folders; place new queries into a folder; render the branch as a tree.
- Backward compatible: existing flat queries keep working (path = slug, folder = "").

**Non-Goals:**
- No drag-and-drop reordering/moving in v1 (move is achievable via `context_rename_query` to a different folder; a DnD affordance is a follow-up).
- No folder-level metadata/renaming of folders in v1 (folders are directories; rename-folder is a follow-up — can be emulated by moving contained queries).
- No change to `.meta.yaml` format, schema-sync, or the aggregate `context_list_linked_queries` behavior beyond adding `path` to its query items.
- No change to the global Saved Queries panel (local-DB) — folders there already exist separately.

## Decisions

**Decision: Identity = relative POSIX path under `queries/`, without extension.**
`path` (e.g. `reports/top-customers`), `folder` (parent dir, `""` at root), and `name` (display, from meta or basename) are distinct. `path` = `folder` + "/" + slug. This is the minimal correct identity that supports same-name-in-different-folders.
- Alternative considered: keep name-based identity with a global-uniqueness constraint across the tree. Rejected — forbids the natural `daily/summary` + `weekly/summary` case, which defeats the point of folders.

**Decision: Folders are real directories; empty folders are first-class.**
`New folder` calls `context_create_query_folder` → `create_dir_all`. Listing reports `folders: string[]` (all dirs, incl. empty) so the tree can show empty folders. Deletion is empty-only for safety (`context_delete_query_folder` refuses non-empty).
- Alternative considered: purely derive folders from query paths (no empty folders). Rejected — the user explicitly wants to *add* folders, implying creating one before it has queries.

**Decision: `context_list_queries` returns `{ queries, folders }` (shape change).**
Cleaner than overloading the array. Update `useContextQueries` and callers. `queries[i]` gains `path`/`folder`.

**Decision: Recursive parse with path validation.**
`parse_queries_dir` walks subdirectories (bounded, ignore hidden/dotdirs), computing each file's path relative to `queries/`. All folder/path inputs are validated: reject absolute paths and `..`; normalize each segment with the existing slug rule so on-disk names stay filesystem-safe. This blocks path traversal outside `queries/`.

**Decision: Render the tree with the existing sidebar tree primitives.**
Prefer reusing `<SidebarTree/>` (as the global panel does) or a small recursive folder/row renderer in `ContextQueriesBranch`, building nodes from `{ queries, folders }`. Folders sort before queries per level; expansion is local component state (persisted expansion is a possible follow-up). Keep styling per `DESIGN.md`.

**Decision: Sequence after `context-queries-per-connection`.**
That change makes the branch the query surface (New query + setup) and is implemented but not yet archived. This change extends the same branch and the same backend commands. Apply/land after it to avoid spec double-modify conflicts; the frontend delta here is ADDED (not a re-modify) to stay conflict-free.

## Risks / Trade-offs

- **[Path-based identity ripples through the API]** → `getQuery`/`renameQuery`/`deleteQuery` and `openContextQuery` switch from name to path. Contained to the context module + branch; typecheck will surface all call sites. Mitigate by doing the type change first and following the compiler.
- **[Recursive walk performance / symlink loops]** → bound the walk to real directories under `queries/`, skip symlinks and dotfiles; query counts are small.
- **[Windows path separators]** → store/compare `path` as POSIX (`/`); convert to OS separators only when joining to the filesystem.
- **[Aggregate listing (`context_list_linked_queries`) is UI-dead but still returns queries]** → add `path` there for type consistency; no behavior change.
- **[Empty folders in git]** → empty dirs aren't tracked by git; acceptable — folders materialize on disk locally and repopulate when queries are added. Note in docs.

## Migration Plan

No data migration. Existing flat queries parse as `folder = ""`, `path = slug`; all current call sites keep working once switched to path (path == name for flat queries). Rollback is a revert of the Rust + TS edits; on-disk subfolders created meanwhile simply become unreadable-as-nested by an older build (files still exist), so no data loss.
