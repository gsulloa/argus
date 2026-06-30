## Why

Postgres saved queries render in the sidebar, but **none** of the open actions work: double-click, `Open`, and `Open in new tab` all silently fail to open a SQL editor tab (issue #209). The root cause is a field-name mismatch between the Postgres tab payload and the central tab-routing logic: the payload carries the owning connection as `initialConnectionId`, but `TabsContext.open()` resolves the target connection set by reading `payload.connectionId`. For Postgres that lookup returns `null`, so `open()` falls back to the focused connection — and when no connection is focused (the saved-queries panel context), the call is a silent no-op and no tab is ever created. MySQL and MSSQL are unaffected because their payloads already expose `connectionId`.

## What Changes

- Fix `extractConnectionId` in `TabsContext` so it resolves the target connection set from a Postgres `postgres-query` payload (which uses `initialConnectionId`) in addition to the `connectionId` used by MySQL/MSSQL tabs.
- As a result, double-click / `Open` / `Open in new tab` on a Postgres saved query reliably opens (or focuses) a `postgres-query` tab loaded with the query's SQL, routed to the saved query's own connection set — even when no connection is currently focused.
- No payload field renames and no breaking changes to the existing `postgres-query` payload contract (`initialConnectionId` stays).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `postgres-sql-editor`: Strengthen the "open a saved query" behavior so opening a `postgres-query` tab routes it to the connection identified by its payload (`initialConnectionId`) and succeeds regardless of whether a connection is currently focused.

## Impact

- **Code:** `packages/app/src/platform/shell/tabs/TabsContext.tsx` (`extractConnectionId`). No backend / Tauri command changes.
- **Behavior:** Postgres saved queries (and context/prefab queries that route through `openQueryTab`) open correctly; the tab lands in the correct per-connection tab set instead of relying on the focused connection.
- **Unaffected:** MySQL and MSSQL saved-query opening (already use `connectionId`); the `postgres-query` payload shape is unchanged.
