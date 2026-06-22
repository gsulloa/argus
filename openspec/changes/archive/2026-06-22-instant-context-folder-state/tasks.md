## 1. Postgres connection form (reference implementation)

- [x] 1.1 In `packages/app/src/modules/postgres/ConnectionForm.tsx`, destructure `items` from `useConnections()` and derive `const liveConn = items.find((c) => c.id === initial.id) ?? initial;` in the edit-mode branch
- [x] 1.2 Pass `contextPath={liveConn.context_path ?? null}` to `ContextFolderRow` instead of `initial.context_path`
- [x] 1.3 Simplify `onChanged` to `() => { void refreshConnections(); }` and remove the `contextTick` state + `key={contextTick}` (confirm `contextTick` is not used elsewhere in the file first)
- [ ] 1.4 Verify: open a saved Postgres connection's config window, link a folder, and confirm the path row and **Sync schema…** button appear without saving or reopening

## 2. Apply the same fix to the other engine forms

- [x] 2.1 `packages/app/src/modules/mysql/ConnectionForm.tsx` — derive `liveConn` from the live registry, pass `liveConn.context_path`, simplify `onChanged`, drop `contextTick`
- [x] 2.2 `packages/app/src/modules/mssql/ConnectionForm.tsx` — same change
- [x] 2.3 `packages/app/src/modules/dynamo/ConnectionForm.tsx` — same change, sourcing the snapshot from `mode.connection` (derive `liveConn` from `mode.connection.id`)
- [x] 2.4 `packages/app/src/modules/athena/ConnectionForm.tsx` — same change
- [x] 2.5 `packages/app/src/modules/cloudwatch/ConnectionForm.tsx` — same change

## 3. Verification

- [x] 3.1 Manually verify the live update for DynamoDB (the reporter's active engine) — link, create-and-link, and unlink each reflect immediately in the open window
- [x] 3.2 Confirm the create-mode placeholder ("Save this connection first to link a context folder.") is unchanged in all six forms
- [x] 3.3 Run `pnpm -C packages/app typecheck` (or the repo's typecheck script) and lint to confirm no unused-variable / type errors after removing `contextTick`
- [x] 3.4 Confirm no console errors when the connection is absent from the store transiently (fallback to the opening snapshot holds)
