## 1. Shared TTL primitives

- [x] 1.1 Add a `SCHEMA_CACHE_TTL_MS = 60 * 60 * 1000` constant and an `isStale(fetchedAt: number | undefined, ttlMs?: number): boolean` helper in a shared location reachable by all engine modules (e.g. `platform/` schema-cache utils).
- [x] 1.2 Add a unit test for `isStale` (undefined → stale, now → fresh, now − 2h → stale).

## 2. Postgres — seed-on-mount + TTL

- [x] 2.1 Record a `fetchedAt` timestamp on the schemas-level entry whenever `globalSchemaCache.recordSchemas` succeeds (`modules/postgres/schema/globalSchemaCache.ts`).
- [x] 2.2 In `useSchemaTree` (`modules/postgres/schema/useSchemaTree.ts`), seed the reducer's initial state from `globalSchemaCache` on mount: if a non-stale schemas entry exists, initialize `schemasState: "loaded"` with the cached schemas and seed any cached `relations` slots to `loaded`, skipping the mount `listSchemas`/`listRelations` calls.
- [x] 2.3 When the seeded entry is stale, render cached data immediately and fire `listSchemas` (+ eager `listRelations` for visible schemas) in the background; replace the cache on success, retain stale data on failure. Guard against races using the existing generation/inflight logic.
- [x] 2.4 Verify forced invalidation (`Schema: Refresh`, refresh button, `postgres:active-changed`, disconnect) still drops the entry including its timestamp.

## 3. MySQL — seed-on-mount + TTL

- [x] 3.1 Record `fetchedAt` on `recordSchemas` in `modules/mysql/schema/globalSchemaCache.ts`.
- [x] 3.2 Seed `useSchemaTree` (`modules/mysql/schema/useSchemaTree.ts`) from cache on mount, mirroring 2.2.
- [x] 3.3 Implement stale serve-then-background-refresh, mirroring 2.3.

## 4. MSSQL — seed-on-mount + TTL

- [x] 4.1 Record `fetchedAt` on `recordSchemas` in `modules/mssql/schema/globalSchemaCache.ts`.
- [x] 4.2 Seed `useSchemaTree` (`modules/mssql/schema/useSchemaTree.ts`) from cache on mount, mirroring 2.2.
- [x] 4.3 Implement stale serve-then-background-refresh, mirroring 2.3.

## 5. Athena — persist across refocus + TTL

- [x] 5.1 Record `fetchedAt` on the schema cache entry in `modules/athena/schema/globalSchemaCache.ts`.
- [x] 5.2 Lift the Athena tree's expanded relations/columns state so it persists across subtree unmount/remount (process-wide store rather than component `useState`), seeding from `athenaSchemaCache` on mount without re-issuing `athena_list_relations`/`athena_list_columns` for already-cached nodes.
- [x] 5.3 On refocus with a stale entry, render cached databases and refresh the listing in the background.
- [x] 5.4 Confirm forced refresh (toolbar button / `athena:schema-refresh`) still clears both schema and NamedQueries caches regardless of TTL.

## 6. DynamoDB — TTL on the existing persistent cache

- [x] 6.1 Record `fetchedAt` on the `tables` slot when it reaches `status: "ready"` in `useDynamoTableCache`.
- [x] 6.2 On subtree mount with a stale `ready` entry, keep showing cached names and re-invoke `dynamo.listTables` in the background; skip refetch when fresh.

## 7. Global Cmd+R forced-reload accelerator

- [x] 7.1 Implement a shell-level `refreshFocusedConnection()` dispatcher that resolves the focused connection's engine and triggers that engine's existing refresh path (drop cache entry + re-fetch), reusing the per-engine refresh-button code path.
- [x] 7.2 Register a `{ key: "r", mod: true, whenInInput: false }` binding in `WorkspaceShell`'s `useShortcuts` that calls the dispatcher and `preventDefault`s the native webview reload; no-op (but still suppress reload) when no connection is focused.
- [x] 7.3 Verify the accelerator routes correctly per engine (Postgres/MySQL/MSSQL/Athena/Dynamo) and does not fire while typing in an input/textarea. (Dispatcher switches by connection kind; binding omits `whenInInput` so it is suppressed in inputs.)

## 8. Verification

- [x] 8.1 Manually verify for each engine: load a connection, switch focus away and back within the TTL → tree renders instantly with no IPC refetch (check network/console for absence of `list*` calls).
- [x] 8.2 Manually verify stale path: simulate an aged entry (lower the TTL constant temporarily) → refocus renders stale data then background-refreshes without a loading flash.
- [x] 8.3 Manually verify `Cmd+R` forces a reload of the focused connection for each engine and the page does not reload in the packaged app.
- [x] 8.4 Run `openspec validate cache-schema-tree-on-connection-switch --strict` and the frontend test suite. (Validate passes; tsc 0 errors; lint 0 errors; engine test suites pass — the only failures are pre-existing `localStorage is not a function` env issues in `ai/ChatPanel` + `useExpandedGroups`, confirmed failing on the clean base.)
