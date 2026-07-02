## Context

`ContextRegistry::get` (`registry.rs:207`) returns the cached `parsed_by_engine` entry and only reparses when the cache is empty. The cache is refreshed by the watcher worker via `on_flush` (`registry.rs:250`), which reparses and emits `context://changed`. `context_save_query`/`rename`/`delete` rely on the watcher (writing files reliably fires it). `context_create_query_folder`/`context_delete_query_folder` (`commands.rs:1477`/`1516`) only touch the filesystem — no cache refresh, no emit — and they don't take the `registry` state. Creating an empty directory doesn't reliably wake the watcher, so the cached `query_folders` stays stale and the branch's immediate `refresh()` misses the new folder.

The per-connection branch (`ContextQueriesBranch.tsx`) renders a recursive tree and has New query / New folder affordances, but query rows are plain activate buttons — no move/rename/delete. The backend already exposes path-based `context_rename_query` (supports cross-folder move), `context_delete_query`, and `context_delete_query_folder`.

## Goals / Non-Goals

**Goals:**
- Empty/nested folders appear immediately after creation (and disappear after deletion).
- Users can move a query to another folder, rename it, and delete it from the branch; delete empty folders.

**Non-Goals:**
- No drag-and-drop reordering (a context-menu picker is enough for v1; DnD is a follow-up).
- No recursive folder deletion (empty-only stays; users delete contents first).
- No changes to the global Saved Queries panel or to backend command *shapes* (only add registry state to two folder commands).

## Decisions

**Decision: Fix visibility in the backend via synchronous reparse + emit.**
Add a public `ContextRegistry` method (e.g. `refresh_and_notify(conn_id, kinds)`) that resolves the connection's canon+engine, reparses via `load_folder`, replaces the cached entry, and emits `context://changed` — reusing the same logic as `on_flush`. `context_create_query_folder`/`context_delete_query_folder` gain `registry: State<Arc<ContextRegistry>>` and call it after the fs op. The frontend's post-create `refresh()` then reads fresh `query_folders`.
- Alternative considered: fix on the frontend by optimistically injecting the created folder into local state. Rejected — leaves the registry cache stale (other subscribers/aggregate listing stay wrong) and re-introduces drift on the next real refresh. Fix at the source.
- Alternative considered: make `registry.get` always reparse. Rejected — defeats the cache; folder ops are the only writers that bypass the watcher, so refresh them explicitly.

**Decision: Move/rename/delete via a Radix context menu on rows; move uses a folder picker.**
Query rows get a right-click `ContextMenu` (Open, Move to folder…, Rename, Delete). "Move to folder…" opens a dialog listing destinations = `["" (root)] + folders`, minus the query's current `folder`. Move → `renameQuery(path, join(dest, slug))` where `slug` = last segment of `path`. Rename → prompt name, `renameQuery(path, join(folder, newSlug))` (slug derived from the new name the same way the backend would; simplest is to let the backend derive — but `to_path` needs a slug, so derive client-side with a shared slug helper, or pass the name and let a thin wrapper compute). Delete → confirm dialog → `deleteQuery(path)`. Folder nodes get "Delete folder" (empty-only) → `deleteQueryFolder(path)`; surface backend error as toast.
- Slug derivation: reuse/mirror the backend slug rule on the client for computing `to_path` on rename. Keep it minimal and documented; the backend still normalizes, so exact parity isn't safety-critical (a mismatch just yields a slightly different slug, not corruption).

**Decision: Refresh via the existing `context://changed` subscription + explicit `refresh()`.**
After any action resolves, call the branch's `refresh()` (already wired) and rely on the now-correct backend to return fresh data. The emitted event also updates any other subscriber.

## Risks / Trade-offs

- **[Client/backend slug parity on rename/move]** → For move, the slug is taken verbatim from the existing `path`'s last segment (no re-slugging), so it round-trips exactly. For rename, derive the slug from the new name with a small shared helper mirroring the Rust rule; a mismatch only changes the filename, not correctness. Document the helper.
- **[Deleting a folder that the watcher later reports]** → the synchronous reparse already reflects the deletion; a duplicate watcher flush is idempotent.
- **[Context-menu surface/DESIGN.md]** → keep the menu minimal and styled per `DESIGN.md`; reuse existing dialog/confirm components (e.g. the shared `NamePromptDialog` and a `ConfirmDialog`).

## Migration Plan

No data migration. Builds on `context-query-folders` (unarchived) — land after it. Rollback is a revert of the registry method + the two command signatures + the branch menu.
