## 1. Simplify SaveAsModal to Name-only

- [x] 1.1 In `packages/app/src/modules/saved-queries/SaveAsModal.tsx`, change `SaveAsModalProps`: remove `defaultFolderId` prop and change `onConfirm` to `(result: { name: string }) => void`.
- [x] 1.2 Remove folder state and logic: `selectedFolderId`, `expandedFolderIds`, `showNewFolder`, `newFolderName`, `isCreatingFolder`, the `useSavedQueries()` usage, `toggleExpand`, `handleCreateFolder`, and the ancestor-expand effect. Keep only Name state and focus behavior.
- [x] 1.3 Remove the Folder label, `folderDisplay`, the folder tree render block, and the `+ New folder…` affordance from the JSX. `handleSubmit` calls `onConfirm({ name: trimmed })`.
- [x] 1.4 Delete the `FolderPickerNode` component and its `FolderPickerNodeProps` interface.
- [x] 1.5 Update the file's top doc comment to describe a Name-only dialog.
- [x] 1.6 In `packages/app/src/modules/saved-queries/SaveAsModal.module.css`, remove the now-unused folder classes (`folderDisplay`, `folderDisplayName`, `folderTree`, `folderItem`, `folderIndent`, `folderIcon`, `folderName`, `folderToggle`, `folderTogglePlaceholder`, `newFolderRow`, `newFolderConfirm`, `newFolderLink`).

## 2. Update the four QueryTab callers

- [x] 2.1 Postgres (`packages/app/src/modules/postgres/sql/QueryTab.tsx`): remove `defaultSaveFolder` state and the `savedQueries:lastUsedFolder` read in `openSaveAsModal`; drop the `defaultFolderId` prop passed to `<SaveAsModal>`; change `handleSaveAsConfirm` to accept `({ name }: { name: string })`.
- [x] 2.2 MSSQL (`packages/app/src/modules/mssql/sql/QueryTab.tsx`): same edits as 2.1.
- [x] 2.3 MySQL (`packages/app/src/modules/mysql/sql/QueryTab.tsx`): same edits as 2.1.
- [x] 2.4 Athena (`packages/app/src/modules/athena/sql/QueryTab.tsx`): same edits as 2.1.
- [x] 2.5 Remove any now-unused imports (`getSetting`, folder-related helpers) left dangling in the four files after the edits.

## 3. Verify

- [x] 3.1 Typecheck the frontend (`pnpm -C packages/app tsc --noEmit` or the repo's equivalent) and resolve any errors from the prop/type changes.
- [x] 3.2 Run the frontend unit tests (`pnpm -C packages/app test`) and fix any that reference the removed folder picker or `SaveAsModal` folder props.
- [ ] 3.3 Manually confirm the first-save flow in Postgres, MySQL, MSSQL, and Athena editors: `Mod-S` opens a Name-only modal, confirming saves into the connection's context folder, and the "no linked context folder" toast still appears when unlinked.
