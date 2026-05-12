# QA Notes — add-saved-queries

Internal reference. Scenarios from both specs cross-referenced against the implementation.

---

## Spec: `saved-queries/spec.md`

### SQLite schema

| Scenario | Implemented? | File | Manual test needed? |
|---|---|---|---|
| Migration applies cleanly on fresh database | Yes | `src-tauri/migrations/0003_saved_queries.sql` | No (Rust unit test 1.5) |
| Cascade delete removes children of deleted folder | Yes | FK `ON DELETE CASCADE` in migration | No (Rust unit test 2.13) |

### List folders and queries

| Scenario | Implemented? | File | Manual test needed? |
|---|---|---|---|
| Empty database returns empty arrays | Yes | `saved_queries/mod.rs` list fn | No (Rust unit test) |
| Mixed root and nested entries | Yes | `list()` two-SELECT approach | No (Rust unit test) |

### Create a folder / query

| Scenario | Implemented? | File | Manual test needed? |
|---|---|---|---|
| Create root folder | Yes | `folder_create` command | Yes — verify `+ New folder` in panel header |
| Create nested folder appends after siblings | Yes | MAX(sort_order)+1 logic | Yes |
| Empty name rejected | Yes | name trim/validate in Rust | Yes — try saving with blank name |
| Create root-level query | Yes | `create` command | Yes |
| Create query with last_connection_id | Yes | `create` accepts last_connection_id | Yes |

### Update / Move / Delete / Duplicate

| Scenario | Implemented? | File | Manual test needed? |
|---|---|---|---|
| Update SQL only | Yes | `update` command, explicit-null handling | Yes |
| Clear last_connection_id | Yes | Option<Option<Uuid>> pattern in Rust | Yes |
| Update non-existent id → NotFound | Yes | Rust returns AppError::NotFound | No (Rust unit test) |
| Rename folder | Yes | `folder_update` | Yes |
| Move query to root | Yes | `move` with target_folder_id=null | Yes — via DnD or "Move to folder…" |
| Move with explicit sort → renumbers siblings | Yes | sibling renumbering in Rust | Yes |
| Move folder under another folder | Yes | `folder_move` | Yes — via DnD |
| Cycle rejected | Yes | recursive CTE in Rust + client-side isCycleMove check | Yes — drag parent onto grandchild; expect toast |
| Self-move rejected | Yes | backend + client-side check | Yes |
| Delete removes row | Yes | `delete` command | Yes |
| Delete folder with cascade | Yes | `folder_delete` + ON DELETE CASCADE | Yes |
| Duplicate appends (copy) | Yes | `duplicate` command | Yes |
| Second duplicate → (copy 2) | Yes | suffix increment logic in Rust | Yes |

### Saved Queries sidebar panel

| Scenario | Implemented? | File | Manual test needed? |
|---|---|---|---|
| Panel renders between Connections and Plataforma | Yes | `Sidebar.tsx` ordering | Yes — visual check |
| Search filters and auto-expands ancestors | Yes | `filterNodes` in `SavedQueriesPanel.tsx` | Yes |
| Clearing search restores expansion | Yes | `persistedExpanded` vs `searchExpanded` split | Yes |

### Context menu and keyboard interactions

| Scenario | Implemented? | File | Manual test needed? |
|---|---|---|---|
| F2 enters rename mode | Yes | `handleTreeKeyDown` in `SavedQueriesPanel.tsx` | Yes |
| Delete query confirms before invoking | Yes | `requestDelete` + `ConfirmDialog` | Yes |
| Delete non-empty folder shows count | Yes | `countDescendants` + dialog copy | Yes |

### Drag-and-drop reorganization

| Scenario | Implemented? | File | Manual test needed? |
|---|---|---|---|
| Drag query into folder | Yes | `handleDndDrop` `into` branch in `SavedQueriesPanel.tsx` | Yes — drag query onto folder row |
| Drag folder into descendant rejected | Yes | `isCycleMove` check + toast + backend validation | Yes — drag parent onto grandchild |
| Drag to reorder within same parent | Yes | `handleDndDrop` `before`/`after` branch | Yes — drag to reorder |
| Source row 50% opacity during drag | Yes | `isDraggingLocal` → opacity 0.4 in `DraggableRow` | Yes |
| Ghost preview following cursor | Yes | `DragOverlay` + `DragGhost` in `SidebarTree.tsx` | Yes |

---

## Spec: `postgres-sql-editor/spec.md` (relevant new scenarios)

| Scenario | Implemented? | File | Manual test needed? |
|---|---|---|---|
| Saved query reopens with last connection | Yes | `openSavedQuery.ts` + `last_connection_id` | Yes — save query, reopen app, check selector |
| Stale connection → selector empty | Yes | `buildArgs` falls back to undefined if conn not in registry | Yes — delete connection, reopen saved query |
| Cmd+S first save opens modal | Yes | `onSave` in `QueryTab.tsx` | Yes |
| Cmd+S subsequent save overwrites | Yes | `onSave` branching on `savedQueryId` | Yes |
| Dirty indicator shown | Yes | `isDirty` + `setTabDirty` → `●` in TabStrip | Yes |
| Close dirty saved-query confirms | Yes | `useCloseConfirm` + `showDiscardDialog` | Yes |
| Select a connection first toast | Yes | `onRun` guard in `QueryTab.tsx` | Yes — run with no connection selected |
| Connection selector dropdown | Yes | `ConnectionSelector.tsx` | Yes — visual check |
| Tab reuse on open saved query | Yes | `openQueryTab` checks `savedQueryId` | Yes — open same query twice |

---

## Task 10.4 — Schema cache observer cleanup

**Status: Verified clean.**

In `QueryTab.tsx` (`src/modules/postgres/sql/QueryTab.tsx`), lines 140–158:
- The `useEffect` that subscribes to `globalSchemaCache` has `tabState.currentConnectionId` in its dep array.
- The cleanup function calls both `unsubscribe()` and `clearTimeout(timer)`.
- When connection changes, the effect re-runs: old subscription torn down, new one created for the new connection.
- When `currentConnectionId` is null (no connection selected), the effect returns early — no subscription created.

No leak possible across connection switches.

---

## Task 10.5 — Entry point smoke check

All `openQueryTab` call sites reviewed:

| Call site | File | Signature correct? |
|---|---|---|
| History "Open in editor" | `query-history/HistoryTab.tsx:223` | Yes — `{ initialConnectionId, initialConnectionName, initialSql }` |
| Command palette "New Query" | `postgres/commands.ts:163` | Yes — `{ initialConnectionId, initialConnectionName, initialSql: "" }` |
| `+ Query` button on connection row | `platform/shell/ConnectionRow.tsx:210` | Yes — `{ initialConnectionId, initialConnectionName, initialSql: "" }` |
| Data viewer "Open in SQL Editor" | `postgres/data/TableViewerTab.tsx:424` | Yes — `{ initialConnectionId, initialConnectionName, initialSql }` |
| Schema tree new query | `postgres/schema/SchemaTree.tsx:908` | Yes — `{ initialConnectionId, initialConnectionName, initialSql: "" }` |

No compilation errors. All call sites use the new connection-agnostic tab ID format.
