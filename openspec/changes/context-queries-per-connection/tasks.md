## 1. Strip context queries from the global Saved Queries panel

- [x] 1.1 In `packages/app/src/modules/saved-queries/SavedQueriesPanel.tsx`, remove the aggregated context UI: `ContextQueriesSection`, `ContextQueryRow`, and their render block below the local tree.
- [x] 1.2 Remove context state/hooks: `useLinkedContextQueries`/`linkedGroups`/`refreshLinked`, `ctxNewTargets`, `showCtxTargetPicker`, `showNewCtxQuery`, `newCtxQueryTargetGroup`, and the "Choose context folder" picker dialog + the context name-prompt dialog.
- [x] 1.3 Remove `handleCreateQuery`, `handleContextQueryCreate`, `handleContextQueryRename`, `handleContextQueryDelete`, and `pickRepresentativeConnection` if now unused (and any now-unused imports).
- [x] 1.4 Change the `+` dropdown to offer only `New folder` (remove the `New query` item). Keep search, DnD, expansion persistence, and all local-query behaviors intact.
- [x] 1.5 Update the empty-state text if needed (local-only panel); do not add a context CTA here.

## 2. Shared context-folder link hook

- [x] 2.1 Extract a reusable hook `useContextFolderLink(connectionId)` from `packages/app/src/modules/context/components/ContextFolderRow.tsx`, exposing `knownFolders`, `loading`, `reuse(path)`, `createNew()` (with the name step), `chooseExisting()`, and error state — built on `contextApi.listKnownFolders`/`createFolder`/`linkFolder` and Tauri `dialogOpen`. If a clean extraction is too invasive, skip the hook and call `contextApi` directly from the branch (note the choice in the PR).
- [x] 2.2 If extracted, refactor `ContextFolderRow` to consume the hook so its behavior stays identical; verify its existing tests still pass.

## 3. Make the per-connection Context Queries branch the create + setup surface

- [x] 3.1 In `packages/app/src/modules/context/components/ContextQueriesBranch.tsx`, add a `New query` affordance (header action) that opens a name prompt, calls `contextApi.saveQuery(connectionId, name, "")`, then triggers the existing open path; surface `Conflict`/errors as a toast. Thread any needed callback through `ConnectionRow.tsx` (branch is already mounted there for PG/MySQL/MSSQL/Dynamo).
- [x] 3.2 Change guard 2 so the branch renders when linked-but-empty (drop the empty-hide) so `New query` is reachable; optionally show an empty hint.
- [x] 3.3 Change guard 1 so that when `contextPath` is null the branch renders a compact setup CTA (reuse a known folder / create new / choose existing) via the hook from task 2, targeting `connectionId`. On success the branch refreshes (connection `context_path` change → re-render).
- [x] 3.4 Style the new affordance and CTA per `DESIGN.md` (read it first); keep them compact and consistent with the existing branch styling. Update `ContextQueriesBranch.module.css` as needed.

## 4. Verify

- [x] 4.1 Typecheck the frontend (`pnpm -C packages/app typecheck`) and resolve any errors from the removals/additions.
- [x] 4.2 Run the frontend unit tests (`pnpm -C packages/app test:run`); remove/update tests asserting the panel's aggregated context section or its `New query`/target-picker, and add tests for the branch's `New query` and unlinked setup CTA. Keep `ContextFolderRow` tests green.
- [ ] 4.3 Manually confirm in the running app (workspace window): the global panel shows only local queries with a `+` menu that has only `New folder`; each active connection's `Context Queries` branch shows its own queries, offers `New query` (which writes into that connection's folder and opens a tab), renders when linked-but-empty, and shows a link/create setup CTA when the connection has no context folder.
