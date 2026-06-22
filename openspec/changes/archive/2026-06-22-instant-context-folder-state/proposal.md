## Why

When a user links a context folder from inside an open connection-config window, the linked state (path row, "Shared with N", and the **Sync schema…** button) does not appear until they save the connection or close and reopen the window. The folder is persisted on disk immediately, but the form keeps rendering a stale snapshot of the connection — so the feature looks broken at the exact moment the user expects feedback. Reported as issue #174 from in-app feedback.

## What Changes

- The connection-config form (`ContextFolderRow` host) SHALL render the context-folder state from the **live** connection record in the registry store, not from the immutable `initial`/`mode.connection` prop snapshot captured when the form opened.
- After a link / unlink / create-and-link action inside an open form, the path row, shared-with count, and **Sync schema…** button SHALL appear or disappear immediately, without requiring Save or a window reopen.
- Applies uniformly across all six engine connection forms that mount `ContextFolderRow`: Postgres, MySQL, MSSQL, DynamoDB, Athena, CloudWatch.
- No backend, command, or on-disk-format changes — `context_link_folder` / `context_unlink` already persist correctly; this is a frontend state-sourcing fix.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `connection-context-folders`: adds a requirement that the connection-config form reflects context-folder link/unlink changes in the open window immediately (live state sourcing), so the Sync button and linked-path UI update without save or reopen.

## Impact

- Affected code (frontend only):
  - `packages/app/src/modules/postgres/ConnectionForm.tsx`
  - `packages/app/src/modules/mysql/ConnectionForm.tsx`
  - `packages/app/src/modules/mssql/ConnectionForm.tsx`
  - `packages/app/src/modules/dynamo/ConnectionForm.tsx`
  - `packages/app/src/modules/athena/ConnectionForm.tsx`
  - `packages/app/src/modules/cloudwatch/ConnectionForm.tsx`
  - Possibly `packages/app/src/modules/context/components/ContextFolderRow.tsx` (consumes the live `contextPath`; already reactive to its prop).
- No changes to Tauri commands, the connection registry API, or the context-folder on-disk format.
- Edit-mode flow only — the create flow still shows "Save this connection first to link a context folder" (the link command requires a persisted connection id); that gating is unchanged.
