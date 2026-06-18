## Context

Connections in the Argus shell are listed by the `Sidebar` component (`src/platform/shell/Sidebar.tsx:70-92`), which consumes a React Context exposed by `ConnectionsProvider` in `src/platform/connection-registry/useConnections.tsx:38-114`. The provider holds an `items` array seeded from `connectionsApi.list()` and re-fetches when its own `create` / `update` / `move` / `remove` methods are called — those wrappers call the underlying `connectionsApi` and then `await refresh()`, which mutates the context state and re-renders the sidebar.

Postgres' connection form (`src/modules/postgres/ConnectionForm.tsx:130-280`) destructures `{ create, update } = useConnections()` and calls those wrappers, so saving a Postgres connection updates the sidebar immediately.

Dynamo's connection form (`src/modules/dynamo/ConnectionForm.tsx:275-335`) imports `connectionsApi` directly and calls `connectionsApi.create()` / `connectionsApi.update()`. The Rust command persists the row, but the React provider never learns about it — its `items` array stays stale until the app is restarted and `ConnectionsProvider` mounts fresh.

There is no Tauri-side event for connection create/update today; the system is pull-based, and the pull is gated behind the context wrappers.

## Goals / Non-Goals

**Goals:**
- The Dynamo connection form's Save, Save & Connect, edit, and duplicate paths cause the sidebar Connections list to reflect the change within the same app session, with no restart.
- Bring the Dynamo form's data-flow pattern in line with the Postgres form so a future "Save & Connect" / `onConnected` flow has a uniform place to hook in.
- Add a regression-proof spec scenario that any future connection form must satisfy.

**Non-Goals:**
- Do not introduce a Tauri event channel for connection create/update. The existing context-wrapper pattern is sufficient and matches Postgres.
- Do not change the Rust `connections.create` / `connections.update` commands, the SQLite schema, or the IPC payload shape.
- Do not refactor the Dynamo form's other behaviors (test, profile picker, credentials-only sub-mode). Touch only the save/persistence path.
- Do not change `connectionsApi`'s public surface.

## Decisions

### 1. Route persistence through `useConnections()` (Option A from investigation)

Replace the two direct `connectionsApi.create(...)` / `connectionsApi.update(...)` call sites in `src/modules/dynamo/ConnectionForm.tsx` with `create(...)` / `update(...)` destructured from `useConnections()`. Those wrappers already call the same underlying API and then `await refresh()`, which is exactly the missing step.

**Alternatives considered:**
- **Option B — call `refresh()` manually after the raw API call.** Rejected: requires injecting the connections context anyway, adds a second code path that future maintainers must remember to mirror, and diverges from the Postgres pattern for no benefit.
- **Option C — emit a Tauri event from the Rust backend on every mutation and have the provider re-fetch on receipt.** Rejected: heavier than the bug warrants, introduces cross-layer state coupling and an extra event listener lifecycle, and the existing pull pattern already works for Postgres. Worth revisiting only if multi-window state sync becomes a requirement (out of scope).

### 2. Mirror Postgres' `onSaved` / `onConnected` callback surface on `DynamoFormController`

`DynamoFormControllerValue` (`src/modules/dynamo/FormController.tsx:12-17`) lacks `onSaved` / `onConnected`. Add them so the controller can react to a save the same way the Postgres controller does. The list-refresh behavior does NOT depend on these callbacks (the context wrapper handles it), but having them in place keeps the two forms structurally aligned and prevents the next contributor from re-introducing the bug by reaching for `connectionsApi` to "get the created row back into a callback".

### 3. Stop importing `connectionsApi` from the Dynamo form

Remove the import once the two call sites are migrated. This is the structural guarantee: if the form has no handle on the raw API, it cannot bypass the context.

### 4. Add a spec requirement, not a stronger Postgres-only scenario

Encode the fix as a new requirement under `dynamo-connection` ("Connection list refresh on save") with a single scenario asserting that after a successful save the sidebar reflects the new connection without a restart. This is cheap to test (E2E or component-level) and prevents regression on any future Dynamo form rewrite.

## Risks / Trade-offs

- **Risk:** A subtle behavior difference between `connectionsApi.create()` and the context wrapper's `create()` (e.g., error shape, return type). → **Mitigation:** The Postgres form already uses the wrapper successfully; the wrapper's signature is a thin `await connectionsApi.create(input); await refresh(); return created;`. The returned `Connection` shape is identical. Verify by reading `useConnections.tsx:65-72`.
- **Risk:** `refresh()` is async and runs after `connectionsApi.create()` resolves; if the dialog closes before `refresh()` settles, the user could briefly see the sidebar without the new row. → **Mitigation:** `create()` `await`s `refresh()` before resolving, so the form's `await create(...)` already waits for the list to be repopulated before the dialog closes.
- **Trade-off:** Adding `onSaved` / `onConnected` to `DynamoFormControllerValue` is dead weight today (no caller consumes it). → Accepted because it aligns the two modules and pays off the moment "Save & Connect" is wired (already in the spec).

## Migration Plan

Pure code refactor in the renderer, no data migration. Rollback is `git revert`. No feature flag needed — the change is behaviorally invisible except for the bug going away.

## Open Questions

None.
