## 1. Wire "New query" in the Workspace subtree

- [x] 1.1 In `ConnectionSubtree.tsx`, import `contextApi` and `useToast`, and add a `makeNewContextQueryHandler(engine)` that calls `contextApi.saveQuery(connectionId, name, "", { folder })` then `openContextQuery(tabs, connectionId, name, engine, { name: result.name, description: null, params: [], tags: [], path: result.rel_path, folder: result.folder })`, surfacing failures via `toast.show(... , "error")` — mirroring `ConnectionRow.makeNewContextQueryHandler`.
- [x] 1.2 Pass `onNewQuery={makeNewContextQueryHandler("<engine>")}` to each of the four `<ContextQueriesBranch>` instances (postgres, mysql, mssql, dynamo) in `ConnectionSubtree.tsx`.

## 2. Use a file icon for the "New query" affordance

- [x] 2.1 In `ContextQueriesBranch.tsx`, import `FilePlus` from `lucide-react` and replace the `Plus` icon in the header "New context query" button with `FilePlus` (keep size/stroke consistent with the neighboring `FolderPlus`). Leave the aria-label/title "New context query" unchanged.
- [x] 2.2 Replace the `Plus` icon in the per-folder "New query in this folder" button with `FilePlus` as well. Remove the now-unused `Plus` import if nothing else uses it.

## 3. Verify

- [x] 3.1 `pnpm -C packages/app typecheck`.
- [x] 3.2 `pnpm -C packages/app test:run`; keep existing `ContextQueriesBranch` tests green (button queried by accessible name, unaffected by the icon swap). Add/adjust a `ConnectionSubtree` test asserting the "New query" affordance renders for a Postgres connection (branch receives `onNewQuery`).
- [ ] 3.3 Manual QA in the running app: in the **Workspace** window, the Context Queries header shows both a file (New query) and folder (New folder) button; creating a query opens an editor tab; the Manager window still behaves as before.
