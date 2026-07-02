## Why

When a user saves a query for the first time from a SQL editor, the `SaveAsModal` presents a **Folder** tree picker (a tree of `saved_query_folders` plus a `+ New folder…` affordance). This is misleading: the selected `folderId` is discarded — the query is always written into the **connection's linked context folder** via `context_save_query`. The prompt asks the user to make a choice that has no effect, adding friction and confusion to every first save.

## What Changes

- The first-save `SaveAsModal` becomes a **Name-only** dialog. It no longer shows the Folder tree picker, the `+ New folder…` affordance, or a default-folder selection.
- Saving a new query targets the current connection's context folder automatically (unchanged behavior — the modal already ignored the picked folder).
- Remove the now-dead `savedQueries:lastUsedFolder` setting read and `defaultSaveFolder`/`defaultFolderId` plumbing from the save flow.
- Applies uniformly to the Postgres, MySQL, MSSQL, and Athena SQL editors (all four share `SaveAsModal`).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `postgres-sql-editor`: the first-save modal drops the Folder picker; the save action writes to the connection's context folder without prompting for a folder.
- `mysql-sql-editor`: same first-save modal simplification.
- `mssql-sql-editor`: same first-save modal simplification.

## Impact

- **Frontend components**:
  - `packages/app/src/modules/saved-queries/SaveAsModal.tsx` — remove folder tree, `FolderPickerNode`, `+ New folder…` affordance, `defaultFolderId` prop, and `folderId` from the `onConfirm` result; keep only the Name field.
  - `packages/app/src/modules/saved-queries/SaveAsModal.module.css` — drop the now-unused folder styles.
  - `packages/app/src/modules/{postgres,mysql,mssql,athena}/sql/QueryTab.tsx` — remove `defaultSaveFolder` state, the `savedQueries:lastUsedFolder` read in `openSaveAsModal`, the `defaultFolderId` prop passed to `SaveAsModal`, and the unused `folderId` param in the confirm handler.
- **Behavior**: no backend/IPC change — `context_save_query` already receives only `connection_id`, `name`, and `sql`. Athena's save flow is affected by the shared component but has no folder-picker spec requirement to modify.
- **No data migration**: the `saved_query_folders` table and the Saved Queries panel folder organization are untouched; only the first-save prompt changes.
