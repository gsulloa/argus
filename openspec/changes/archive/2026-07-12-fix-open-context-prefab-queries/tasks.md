## 1. Thread focus context into the open path

- [x] 1.1 In `packages/app/src/modules/context/openContextQuery.ts`, extend the function signature to accept a focus context. Implemented as required last parameter `focus: OpenContextQueryFocus` with the minimal needed shape `{ setFocused: (id: string) => void; isOpen: (connectionId: string) => boolean }` (dropped the unused `focusedConnectionId` — the context-query path has no focused-connection fallback like `openSavedQuery.ts`). Required, so the type checker flags any omitting call site.
- [x] 1.2 Switch focus once at the top of the function (before the `switch`), guarded by `isOpen(connectionId)`, so all opening engine cases (postgres/mysql/mssql/dynamo) surface the tab BEFORE the tab is opened.
- [x] 1.3 Dynamo receives the focus context via the shared top-of-function switch (parity). Athena's Context Queries branch is not rendered by either host, and the CloudWatch case remains a no-op — both unchanged.

## 2. Update call sites

- [x] 2.1 In `ConnectionSubtree.tsx`, read `FocusedConnectionCtxRef` nullably via `useContext` + `useOpenConnections().isOpen`, build `contextQueryFocus`, and pass it to all 5 `openContextQuery` calls (4 `onActivate` + `makeNewContextQueryHandler`).
- [x] 2.2 In `ConnectionRow.tsx`, same pattern reusing the existing `openRegistry.isOpen`. Used nullable `useContext(FocusedConnectionCtxRef)` (NOT `useFocusedConnection()`, which throws) because this component also renders in manager mode without a `FocusedConnectionProvider`. Passed `contextQueryFocus` to all 5 call sites.
- [x] 2.3 Grepped for all callers of `openContextQuery` — the two hosts are the only ones. `pnpm typecheck` passes with no errors.

## 3. Regression tests

- [x] 3.1 Added `packages/app/src/modules/context/__tests__/openContextQuery.test.ts`: asserts `setFocused("conn-1")` is called and `openQueryTab` receives `initialConnectionId: "conn-1"` / `initialSql: "SELECT 1;"` when open; and that `setFocused` is NOT called when `isOpen` is false (tab still opens).
- [x] 3.2 Existing coverage preserved; updated `ConnectionSubtree.test.tsx` for the new 5th arg and `Sidebar.dnd.test.tsx`'s FocusedConnectionContext mock to export `FocusedConnectionCtxRef`. Full suite: 1631 tests pass.

## 4. Verify

- [ ] 4.1 (manual QA) Run the app: link a Postgres connection to a context folder with prefab queries, focus a *different* connection, then click a prefab query under the first connection's Context Queries branch — confirm focus switches and the SQL tab opens with the query body. _Requires a live Postgres + context folder; covered in behavior by the 3.1 regression test._
- [ ] 4.2 (manual QA) Repeat the single-connection case (query's connection already focused) to confirm no regression.
- [x] 4.3 Frontend test suite green: `pnpm exec vitest run` → 129 files, 1631 tests passed (3 todo, 1 skipped).
