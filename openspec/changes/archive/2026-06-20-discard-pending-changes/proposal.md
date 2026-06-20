## Why

After editing rows in the data grid, there is no confirmation when the user **refreshes the table** (⌘R / hard-refresh / reload button): pending uncommitted edits are silently dropped. This is the core complaint in issue #148 — TablePlus asks for confirmation before discarding changes on refresh, Argus does not. The discard/confirm infrastructure already exists for **tab close** and **tab switch**, but the **refresh path is unguarded** on every engine, and the always-visible "discard" affordance is inconsistent across engines.

## What Changes

- **Guard the refresh/reload path against pending edits.** When the user triggers a table refresh (⌘R, hard-refresh ⌘⇧R, or the reload button) while there are pending edits, show the existing "Discard N changes?" confirmation dialog instead of silently dropping the buffer. Cancel keeps the edits; Confirm discards them and refreshes. When the buffer is clean, refresh proceeds with no dialog (no behavior change).
- **Consistent visible "Discard changes" affordance.** Surface a pending-edit count and an explicit **Discard** button in the data-grid toolbar across Postgres, MySQL, and MSSQL whenever the edit buffer is dirty, so discarding does not require closing the tab. The Discard button reuses the same confirmation dialog.
- **DynamoDB parity.** Extend the existing DynamoDB "unsaved-draft guard" to also fire on table refresh (⌘R / ⌘⇧R), matching the close/switch behavior already specified.
- No backend/Tauri command changes; this is a frontend interaction + confirmation-flow change.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `postgres-data-edit`: refresh/reload MUST prompt for confirmation when the edit buffer is dirty; toolbar MUST expose a visible discard affordance with a pending-edit count.
- `mysql-data-edit`: same refresh-confirmation and visible-discard requirements as Postgres.
- `mssql-data-edit`: same refresh-confirmation and visible-discard requirements as Postgres.
- `dynamo-data-edit`: the "Unsaved-draft guard" requirement extends to cover the table refresh action (⌘R / hard refresh), not only close/switch/row-change.

## Impact

- **Frontend (`packages/app/src`):**
  - SQL engines: `modules/{postgres,mysql,mssql}/data/TableViewerTab.tsx` (the ⌘R / reload handlers and toolbar), reusing `modules/postgres/data/DiscardChangesDialog.tsx` and the `useEditBuffer` `hasDirty` / `dirtyCounts` / `clear()` API.
  - DynamoDB: `modules/dynamo/data-view/DataViewTab.tsx` refresh handlers, reusing `edit/DiscardChangesDialog.tsx` and `useUnsavedDraft`.
- **No changes** to Tauri commands, `applyTableEdits`, or the edit-buffer model itself.
- **Tests:** extend the `TableViewerTab` test suites (MySQL/MSSQL) and add Postgres coverage for the refresh-guard path; extend `useUnsavedDraft` / DynamoDB refresh tests.
- **Design:** dialog and toolbar button must follow `DESIGN.md` (accent/danger tokens, no decorative styling).
