## 1. Diagnose & fix the Saved Queries regression (issue #181)

- [x] 1.1 Reproduce: launch the app (`pnpm tauri dev`) against the shared `argus.db`; confirm whether `saved_queries_list` returns rows and whether the panel renders them or shows the empty state. — ROOT CAUSE FOUND (code-level): `SavedQueriesPanel` is only rendered by the legacy `Sidebar.tsx`, used by the now-orphaned `App`/`Shell`. The dual-window refactor (#175/#177) routes `main.tsx` to `ManagerShell`/`WorkspaceShell`, neither of which mounts the panel. Store still bootstraps via `ShellMain` but nothing renders it.
- [x] 1.2 Trace the load path: verify `SavedQueriesBootstrap` mounts and `savedQueriesStore.loadAll()` actually runs in the current shell (check for breakage from the dedicated-windows refactor #175/#177); check for swallowed errors in `store.ts` / `api.ts`. — `store.ts`/`api.ts` are sound; `SavedQueriesBootstrap` runs in the workspace window (via `ShellMain`). The break is purely that the panel component is not mounted in the new shells.
- [x] 1.3 Verify `buildTree(folders, queries)` (`src/modules/saved-queries/types.ts`) and `<SidebarTree />` render non-empty input, and the empty-state condition in `SavedQueriesPanel.tsx` isn't masking populated state. — `buildTree`/empty-state are correct; not the cause.
- [x] 1.4 Apply the minimal fix for the identified root cause; confirm existing local queries render again.
- [x] 1.5 Add a regression test (store/tree unit test asserting a non-empty `saved_queries_list` renders rows, not the empty state) and document a manual check in the change.

## 2. Backend — context query authoring commands

- [x] 2.1 In `modules/context/`, add a slug derivation helper (filesystem-safe, deterministic) and reuse the engine→extension + `<root>/<engine>/queries/` path derivation from `parser.rs`/`sync.rs`.
- [x] 2.2 Implement `context_save_query({ connection_id, name, sql, description?, params?, tags? })` in `commands.rs`: resolve canonical `context_path` + engine, reject `NoContextFolder`/empty name, create dir, write `<slug>.<ext>` + `<slug>.meta.yaml`, create vs update (Conflict on create-collision), return `QueryDoc`. Mirror `context_save_model`.
- [x] 2.3 Implement `context_rename_query({ connection_id, from_name, to_name })`: rename both sibling files, update `name` in meta, `Conflict` on target exists, `NotFound` on missing source.
- [x] 2.4 Implement `context_delete_query({ connection_id, name })`: remove both sibling files, `NotFound` if absent.
- [x] 2.5 Ensure each authoring command results in a `context://changed` event with `kinds` including `"query"` for the folder path (rely on the watcher and/or emit proactively to avoid debounce lag).
- [x] 2.6 Register the three commands in `lib.rs`.
- [x] 2.7 Rust unit/integration tests for save (create + update + conflict + no-folder + per-engine ext), rename, delete, and event emission.

## 3. Backend — aggregate context-query listing

- [x] 3.1 Implement `context_list_linked_queries()`: enumerate connections with non-null `context_path`, canonicalize + dedupe roots, group per `{ canonical_root, project_name, engine, representative_connection_id, queries[] }`; prefer a connected connection as representative.
- [x] 3.2 Register the command in `lib.rs`.
- [x] 3.3 Tests: two connections sharing a root collapse to one group per engine; representative is the connected connection; empty result when no folders linked.

## 4. Frontend — context authoring + aggregate API/hooks

- [x] 4.1 Add `contextApi.saveQuery / renameQuery / deleteQuery` and `contextApi.listLinkedQueries` to `modules/context/api.ts`.
- [x] 4.2 Add a `useLinkedContextQueries()` hook in `modules/context/hooks.ts` that fetches the aggregate list and refreshes on `context://changed` (`kinds` includes `"query"`).

## 5. Frontend — unified Saved Queries panel

- [x] 5.1 Extend the saved-queries store/types so panel nodes carry `source: "local" | "context"` plus context metadata (`canonicalRoot`, `projectName`, `engine`, `representativeConnectionId`, `queryName`).
- [x] 5.2 Merge local-DB queries (with folders) and aggregated context queries into the tree, grouping context entries by project → engine with a source badge; dedupe by `(canonicalRoot, engine, name)`.
- [x] 5.3 Keep local search/expansion/persistence (`savedQueries:expandedFolders`) working over the merged tree; ensure search auto-expand doesn't pollute persisted state.
- [x] 5.4 Wire opening/running a context query to the group's representative connection, reusing the existing `context-queries-runner` open + parameter-substitution flow.
- [x] 5.5 Verify the panel refreshes live on `context://changed` query events.

## 6. Frontend — route creation to the context folder

- [x] 6.1 Update the panel `+` `New query` action: single linked folder → default target; multiple → folder/connection picker; none linked → CTA to link/create a context folder. Stop calling `saved_queries_create`.
- [x] 6.2 Add/wire a `Save query` action in the SQL editor toolbar(s) that writes the current editor's SQL to the active connection's context folder via `context_save_query` (prompt to link a folder if none).
- [x] 6.3 Wire rename/edit/delete of context-query nodes to `context_rename_query` / `context_save_query` (update) / `context_delete_query`; keep local-DB node actions on the existing `saved_queries_*` commands.
- [x] 6.4 Keep `New folder` scoped to the local-DB folder tree only (context queries are flat).

## 7. Docs, validation & verification

- [x] 7.1 Update `README.md` "Context folders" and `docs/context-folder-example/` to document query authoring (create/rename/delete, file layout).
- [x] 7.2 `openspec validate saved-queries-in-context --strict` passes; run frontend + Rust test suites and `pnpm tsc`/lint.
- [x] 7.3 Manual end-to-end check — confirmed by user (manual testing passed). Steps recorded in MANUAL-CHECK.md.
