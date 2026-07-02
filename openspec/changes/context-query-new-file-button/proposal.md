## Why

In the **Workspace** window the Context Queries branch shows only a "New folder" button — the "New query" (new file) affordance is missing, so users can create folders but not queries from the sidebar there. This is because the Workspace render path (`ConnectionSubtree`) never wires the branch's `onNewQuery` handler, unlike the Manager window (`ConnectionRow`) which shows both. The result is an inconsistent, incomplete header (see the reported screenshot: only the folder icon appears).

## What Changes

- **Wire "New query" in the Workspace subtree.** `ConnectionSubtree` passes an `onNewQuery` handler to `ContextQueriesBranch` for the four query engines (Postgres, MySQL, MSSQL, Dynamo), mirroring `ConnectionRow`'s existing handler: create an empty query file via `contextApi.saveQuery(name, "", { folder })`, then open it in an editor tab. This makes the "New query" button (and the per-folder "New query in folder" action) appear in the Workspace, next to "New folder".
- **Give the "New query" button a file icon.** The new-query affordance currently uses a generic `Plus` icon; switch it to a file icon (`FilePlus`) so it clearly reads as "new file" beside the folder's `FolderPlus` — in both the branch header and the per-folder action row.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `context-queries-runner`: the Context Queries sidebar branch offers a "New query" action (creating an empty query that opens in an editor tab) alongside "New folder" in **every** place the branch renders — including the Workspace window, where it is currently absent.

## Impact

- **Frontend** `packages/app/src/platform/shell/ConnectionSubtree.tsx`: add an `onNewQuery` handler (per engine) that calls `contextApi.saveQuery` then `openContextQuery`, mirroring `ConnectionRow.makeNewContextQueryHandler`. Requires `useToast` for the failure path.
- **Frontend** `packages/app/src/modules/context/components/ContextQueriesBranch.tsx`: swap the new-query button icon from `Plus` to `FilePlus` (header button + per-folder "New query in folder" button). No behavior change to the folder button.
- No backend changes — `context_save_query` / `openContextQuery` already exist and are used by the Manager path.
- Tests: extend `ContextQueriesBranch` tests only if the icon swap affects existing queries; the wiring is covered by a `ConnectionSubtree` behavior check.
