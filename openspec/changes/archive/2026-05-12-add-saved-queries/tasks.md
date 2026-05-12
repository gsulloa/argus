## 1. Backend — SQLite schema and module scaffolding

- [x] 1.1 Create migration `src-tauri/migrations/0003_saved_queries.sql` with `saved_query_folders` and `saved_queries` tables, foreign keys (cascade), and indexes per spec
- [x] 1.2 Create module directory `src-tauri/src/modules/saved_queries/` with `mod.rs` and `commands.rs`
- [x] 1.3 Define Rust types: `SavedQueryFolder`, `SavedQuery`, `ListResponse`, request/response structs (with `serde` derives matching frontend payload shapes)
- [x] 1.4 Register the new module in `src-tauri/src/modules/mod.rs`
- [x] 1.5 Add a smoke test that the migration applies cleanly on a fresh SQLite file

## 2. Backend — CRUD commands

- [x] 2.1 Implement `list(conn) -> ListResponse` in `mod.rs` (two ordered SELECTs, no per-row queries)
- [x] 2.2 Implement `folder_create(conn, parent_id, name) -> SavedQueryFolder` with name trim/validate and sort_order computation
- [x] 2.3 Implement `folder_update(conn, id, name) -> SavedQueryFolder` returning NotFound for missing id
- [x] 2.4 Implement `folder_move(conn, id, target_parent_id, target_sort_order?)` with recursive CTE cycle detection and sibling renumbering
- [x] 2.5 Implement `folder_delete(conn, id) -> { folders_deleted, queries_deleted }` relying on `ON DELETE CASCADE`
- [x] 2.6 Implement `create(conn, folder_id, name, sql, last_connection_id?) -> SavedQuery` with validation and sort_order
- [x] 2.7 Implement `update(conn, id, name?, sql?, last_connection_id?)` with explicit-null handling for `last_connection_id`
- [x] 2.8 Implement `move(conn, id, target_folder_id, target_sort_order?)` with sibling renumbering
- [x] 2.9 Implement `delete(conn, id) -> ()` returning NotFound for missing id
- [x] 2.10 Implement `duplicate(conn, id) -> SavedQuery` with `(copy)` / `(copy N)` suffix increment
- [x] 2.11 Wire all commands in `commands.rs` (`#[tauri::command]` wrappers, `AppResult` returns, snake_case names)
- [x] 2.12 Register commands in `src-tauri/src/lib.rs` invoke handler list
- [x] 2.13 Unit tests in `mod.rs` covering: cycle rejection, cascade delete, duplicate suffix increment, move with sibling renumbering, NotFound on missing id

## 3. Frontend — saved-queries module foundations

- [x] 3.1 Create directory `src/modules/saved-queries/`
- [x] 3.2 `api.ts`: TypeScript wrappers for every Tauri command with typed payloads matching backend serde shapes
- [x] 3.3 `types.ts`: `SavedQueryFolder`, `SavedQuery`, `TreeNode = FolderNode | QueryNode`, `Tree` builder utilities
- [x] 3.4 `store.ts`: in-memory store (Zustand or signal-based, matching existing project pattern) that loads the list on app boot, exposes `folders`, `queries`, computed `tree`, and CRUD action methods that invoke `api.ts` and refresh the store
- [x] 3.5 `useSavedQueries.ts`: React hook that subscribes to the store and returns the tree + actions
- [x] 3.6 Tree builder unit test: assemble `folders[] + queries[]` into ordered nested `TreeNode[]` per spec sort rules

## 4. Frontend — SavedQueriesPanel sidebar UI

- [x] 4.1 `SavedQueriesPanel.tsx`: container with header (`Saved Queries` label + `+` button), search input, and `<SidebarTree />` rendering the tree
- [x] 4.2 Wire the `+` button to a small menu (`New query` / `New folder`) and to keyboard shortcut on the panel header
- [x] 4.3 Implement search filtering (case-insensitive substring match) with auto-expand-ancestors behavior; preserve user-driven expansion in `savedQueries:expandedFolders` setting (debounced 200ms)
- [x] 4.4 Implement context menu component with the action lists from spec (different items per node kind)
- [x] 4.5 Implement inline rename: F2 / double-click on label → input, Enter commits, Escape cancels, empty trimmed cancels
- [x] 4.6 Implement keyboard navigation passthrough: F2 (rename), Enter (open), Backspace/Delete (delete with confirm)
- [x] 4.7 Implement `Move to folder…` modal (reuses folder tree picker from save modal)
- [x] 4.8 Implement confirmation dialogs for delete (query: `Delete query "<name>"?`, empty folder, non-empty folder with item count)
- [x] 4.9 Wire `<SidebarTree />`'s `dnd-kit` integration for: query→folder move, folder→folder move (with cycle visual abort), reorder within parent (drop between rows) — Option A: extended SidebarTree with `enableDnd`/`onDndDrop`/`isDndDropAllowed` props; schema browser unaffected (no enableDnd prop passed)
- [x] 4.10 Mount `SavedQueriesPanel` in `src/platform/shell/Sidebar.tsx` between `ConnectionsSection` and `PlatformSection`

## 5. Frontend — Refactor postgres-query tab id and connection model

- [x] 5.1 Change tab id generator: `pgquery:<connectionId>:<uuid>` → `pgquery:<uuid>` in `src/modules/postgres/sql/` (find all references via grep on `pgquery:`)
- [x] 5.2 Update tab payload type: `{ initialConnectionId?, initialConnectionName?, initialSql, savedQueryId? }`; keep separate from runtime state
- [x] 5.3 Introduce `useQueryTabState` (or extend existing hook) to hold `currentConnectionId`, `currentConnectionName`, `savedQueryId`, `savedSql`, `savedName`, `savedFolderId`, `editedName`
- [x] 5.4 Update `openQueryTab` signature to accept `{ initialConnectionId?, initialSql, savedQueryId? }` and to reuse existing tab when `savedQueryId` matches an open tab
- [x] 5.5 Add `openSavedQueryInNewTab` variant that bypasses the reuse check
- [x] 5.6 Update `useQueryRun` to read `connectionId` from tab state (not closure capture); validate non-null before invoking `postgres_run_sql` / `postgres_run_sql_many` and surface toast `Select a connection first.` otherwise
- [x] 5.7 Update the global `Query <N>` counter to be app-global (not per-connection) and to reset on app launch
- [x] 5.8 Update tab title resolution: saved query name if `savedQueryId` is set, else `Query <N>`
- [x] 5.9 Manual check (or test): existing entry points (`+ Query` sidebar button, palette `New Query`, History "Open in editor", data viewer "Open in SQL Editor") all keep working under the new id format

## 6. Frontend — Connection selector in editor toolbar

- [x] 6.1 Add `<ConnectionSelector />` component listing connections from the connection registry, ordered as in the Connections sidebar, with status dot reused from the sidebar
- [x] 6.2 Mount the selector as the leftmost element of the editor toolbar in `QueryTab.tsx`
- [x] 6.3 On select, update `currentConnectionId` / `currentConnectionName` in tab state
- [x] 6.4 On connection change: dispatch the autocomplete `Compartment` reconfigure with the new namespace (reuse the existing schema-cache-driven reconfigure path)
- [x] 6.5 On connection change: reset `runner.state` to idle (result panel returns to hint state)
- [x] 6.6 On connection change, when `savedQueryId` set: debounce 1000ms then invoke `saved_queries_update({ id, last_connection_id })`
- [x] 6.7 Subscribe to connection-registry events to keep the dropdown list reactive (add/remove/rename/status)

## 7. Frontend — Save action and SaveAsModal

- [x] 7.1 Add `Save` button to editor toolbar in `QueryTab.tsx` (between connection selector and Format)
- [x] 7.2 Bind `Mod-S` at `Prec.highest` in `QueryEditor.tsx` keymap
- [x] 7.3 Implement `onSave` flow: first-save branch (open `SaveAsModal`) vs subsequent-save branch (direct update)
- [x] 7.4 No-op when tab is not dirty
- [x] 7.5 Implement `SaveAsModal.tsx` with Name input (required, trimmed), Folder tree picker (default from `savedQueries:lastUsedFolder` setting), and inline `+ New folder…` affordance
- [x] 7.6 On modal confirm: invoke `saved_queries_create`, update tab state, persist `savedQueries:lastUsedFolder`, surface success toast
- [x] 7.7 Surface success/failure toasts for both first-save and overwrite paths

## 8. Frontend — Dirty state and close confirmation

- [x] 8.1 Compute `dirty` derived value per tab state (saved-query branch vs ad-hoc branch)
- [x] 8.2 Render leading `● ` in tab title when dirty (`TabStrip` / tab title resolver)
- [x] 8.3 Tooltip `Unsaved changes` on the dirty indicator
- [x] 8.4 Intercept tab close gesture: if `dirty && savedQueryId` show confirm dialog `Discard unsaved changes to "<name>"?`; else close immediately
- [x] 8.5 Ensure `pgQueryBuffer:<tabId>` cleanup still runs on actual close (per existing requirement, including StrictMode replay safety)

## 9. Saved-query open flow

- [x] 9.1 Implement `openSavedQuery(id)` action: read query from store, find existing tab with matching `savedQueryId`, focus or create new tab with `initialConnectionId = last_connection_id (if valid)`, `initialSql = sql`, `savedQueryId = id`
- [x] 9.2 Wire double-click and `Enter` on tree query node to `openSavedQuery`
- [x] 9.3 Wire context menu `Open in new tab` to `openSavedQueryInNewTab`
- [x] 9.4 Handle stale `last_connection_id` (connection no longer in registry): open with no connection selected; toolbar selector shows placeholder

## 10. Polish, theming and verification

- [x] 10.1 Apply `DESIGN.md` tokens consistently across `SavedQueriesPanel`, modals, context menu (fonts, colors, spacing, borders, radii) — no emoji, no gradient, no bubbly radii
- [x] 10.2 Ensure all new copy is in line with existing tone (English in UI strings; toast messages match existing style)
- [x] 10.3 Manual QA: every scenario from `specs/saved-queries/spec.md` and `specs/postgres-sql-editor/spec.md` is exercised in the running app — see `qa-notes.md`
- [x] 10.4 Verify schema cache observer cleanup: switching connection 5+ times in the same tab does not leak observers — cleanup verified in `QueryTab.tsx`, dep array correct, unsubscribe called on cleanup
- [x] 10.5 Smoke test the existing "Open in editor" flows from history and data viewer continue to work with the new tab id format — all 5 call sites verified in `qa-notes.md`
- [x] 10.6 Update CHANGELOG with the user-visible additions: Saved Queries panel, connection selector in editor, Cmd+S save shortcut, dirty indicator
