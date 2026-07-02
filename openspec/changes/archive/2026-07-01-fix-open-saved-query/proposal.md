## Why

Opening a saved query from the Saved Queries panel sometimes does nothing: no tab appears, no error, no console warning. The tab system is scoped per connection (each connection owns its own tab set, and only the focused connection's set is visible), but the saved-query open flow neither switches focus to the query's connection nor handles the case where no connection resolves. The result is a silent no-op that reads as a broken feature.

## What Changes

- **Opening a saved query MUST reliably surface a tab.** When a query is bound to a live connection, opening it switches focus to that connection so the newly opened tab is visible in the tab strip (today the tab lands in the target connection's *hidden* set when a different connection — or none — is focused).
- **Handle the no-connection case gracefully.** When a saved query has no `last_connection_id` (or references a connection that is no longer live) and no connection is currently focused, the open flow MUST NOT silently no-op. It falls back to the focused connection when one exists; when none exists, it surfaces a clear affordance (prompt to focus/select a connection) instead of doing nothing.
- **`tabs.open()` MUST NOT silently discard a tab.** The `TabsContext.open()` early-return (`return ""` when no connection resolves) is the root swallow point; callers of the saved-query open flow must guarantee a resolvable target, and the panel open action must react when opening is not possible.
- Reconcile the stale "tabs are connection-agnostic" comment in `openQueryTab.ts` with the actual per-connection tab model.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `saved-queries`: The "Open" / "Open in new tab" flow requirement changes so that activating a query reliably surfaces its tab — switching focus to the query's live connection, and handling the no-connection / non-live-connection case without a silent no-op.
- `app-shell`: The center tab system requirement clarifies that opening a tab for a connection that is not currently focused switches focus so the tab becomes visible, rather than depositing it in a hidden per-connection set.

## Impact

- Frontend:
  - `packages/app/src/modules/saved-queries/openSavedQuery.ts` (`openSavedQuery`, `openSavedQueryInNew`, `buildArgs`)
  - `packages/app/src/modules/saved-queries/SavedQueriesPanel.tsx` (open/activate handler)
  - `packages/app/src/platform/shell/tabs/TabsContext.tsx` (`open()` no-op / focus resolution)
  - `packages/app/src/modules/postgres/sql/openQueryTab.ts` (stale comment; possibly title/focus wiring)
  - MySQL / MSSQL open helpers (`openMysqlQueryTab.ts`, `openMssqlQueryTab.ts`) share the same tab-open path.
- Focused-connection context (`platform/shell/FocusedConnectionContext`) is read/updated as part of the fix.
- No backend (Rust/Tauri) or schema changes expected — this is a frontend routing/focus bug.
