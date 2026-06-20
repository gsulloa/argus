## Why

Since the move to the dual-window shell, the Workspace sidebar mounts the schema/table subtree **only for the focused connection**. Switching focus in the rail unmounts the previous connection's tree and mounts the new one from scratch; the per-engine `useSchemaTree` state machine starts at `idle` on every mount and re-issues `listSchemas` (and then relations), even when the same data was fetched seconds ago. A process-wide `globalSchemaCache` already exists, but the local state machine is never seeded from it on mount. The result is sluggish back-and-forth navigation and redundant queries against the database — painful against production.

## What Changes

- **Persist the schema tree across focus switches.** On mount, each engine's tree seeds its local state from the process-wide cache so returning to an already-loaded connection renders instantly with **no refetch**.
- **Add a per-entry timestamp + ~1h TTL.** When a connection is refocused and its cached entry is older than the TTL, the tree renders the stale cache immediately and refreshes in the background. Fresh entries are never refetched on focus switch.
- **Forced manual reload.** A global `Cmd+R` / `Ctrl+R` accelerator in the Workspace invalidates and reloads the **focused** connection's tree on demand, complementing the existing per-tree refresh button.
- Applies to all five engines — Postgres, MySQL, MSSQL, DynamoDB, Athena — and their respective tree caches.
- The cache remains in-memory only and is never persisted to disk.

## Capabilities

### New Capabilities
<!-- None — this changes the caching behavior of existing schema/table browsers. -->

### Modified Capabilities
- `postgres-schema-browser`: schema cache seeds local state on remount and persists across focus switches; adds per-entry timestamp with ~1h TTL background refresh.
- `mysql-schema-browser`: same cache-persistence + TTL behavior for the MySQL schema tree.
- `mssql-schema-browser`: same cache-persistence + TTL behavior for the MSSQL schema tree.
- `athena-schema-browser`: Glue-backed schema cache persists across focus switches with TTL background refresh.
- `dynamo-table-browser`: table-list cache persists across focus switches with TTL background refresh.
- `dual-window-shell`: adds a global `Cmd+R` / `Ctrl+R` Workspace accelerator that forces a reload of the focused connection's schema/table tree.

## Impact

- **Frontend (per engine):** `useSchemaTree.ts` (Postgres/MySQL/MSSQL) — seed reducer from cache on mount, skip refetch when fresh; `globalSchemaCache.ts` (Postgres/MySQL/MSSQL/Athena) — add per-entry `fetchedAt` timestamps + TTL helpers; Athena tree (`athenaSchemaCache` + local state) and DynamoDB tree (`useDynamoTableCache`) — equivalent seed-on-mount + TTL handling.
- **Shell:** `WorkspaceShell` shortcut bindings (`useShortcuts`) — register `Cmd+R` / `Ctrl+R` routing to the focused connection's refresh; ensure the browser/Tauri default reload is suppressed.
- **No backend/IPC changes** — same `listSchemas` / `listRelations` / table-list commands; only when they fire changes.
- **No on-disk persistence; no schema migrations.**
