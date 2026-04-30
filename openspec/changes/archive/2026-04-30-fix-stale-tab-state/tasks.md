## 1. Fix `useSetting` key-change semantics

- [x] 1.1 In `src/platform/settings/useSetting.ts`, add a `prevKeyRef = useRef(key)` and a render-time block that, when `prevKeyRef.current !== key`, updates the ref, calls `setValue(memoryCache.get(key) ?? defaultValue)`, and calls `setLoaded(memoryCache.has(key) || !isTauriRuntime())`. Document the pattern with a one-line comment ("React: setState during render is allowed when derived from props — see React docs"). Do NOT change the existing `useEffect([key])` async loader.
- [x] 1.2 Add a unit test at `src/platform/settings/useSetting.test.tsx`: render a hook with `key="A"`, set a non-default value, then re-render with `key="B"` (no setter call). Assert the returned value is the default for B (or whatever was previously cached for B), NOT A's value. Add a follow-up rerender with `key="A"` and assert A's value is restored from cache.
- [x] 1.3 Add a regression test at `src/modules/postgres/data/useTableFilter.test.tsx`: render the hook with relation A, persist filter X, re-render the same hook instance with relation B, assert `applied` is the empty model (B has no persisted filter). Then re-render with relation A and assert filter X comes back.

## 2. Fix `useQueryBuffer` StrictMode replay race

- [x] 2.1 In `src/modules/postgres/sql/useQueryBuffer.ts`, REMOVE the `setSetting(key, JSON.stringify(""))` call from the unmount cleanup. Keep the write-timer flush in the same cleanup so debounced writes don't fire after unmount.
- [x] 2.2 In the same file, add a `registerCloseHandler(tabId, async () => { setSetting(key, ""); return true; })` registration in a `useEffect([tabId])` that unregisters via `unregisterCloseHandler(tabId)` on unmount. (Imports come from `@/platform/shell/tabs/useCloseConfirm`.) Confirm the existing `useCloseConfirm` for the data viewer is not on the same tab id (it isn't — they're different tab kinds).
- [x] 2.3 Add a unit test at `src/modules/postgres/sql/useQueryBuffer.test.tsx` (new file): render the hook under `<React.StrictMode>` with a non-empty fallback `"SELECT 1"`, assert that after the strict-mode replay settles, `loaded === true` and `initialSql === "SELECT 1"`. Mock `@/platform/settings/api`'s `getSetting` to a deferred promise that resolves with `null` so we can observe the race.
- [x] 2.4 Add a verification test that `shouldCloseTab(tabId)` triggers the buffer wipe: register the close handler, call `shouldCloseTab`, assert `setSetting` was called with the key and an empty string.

## 3. Add a TableViewerTab regression test for the relation-change scenario

- [x] 3.1 In `src/modules/postgres/data/TableViewerTab.test.tsx`, add a new case: render `<TableViewer>` with `(conn, public, A)`, apply a structured filter via the bar, then rerender the SAME `<TableViewer>` instance (no unmount — controlled by parent props) with `(conn, public, B)`. Assert the bar's value input is empty and `screen.getByText(/No filters yet/)` is present. Then rerender with `(conn, public, A)` and assert the filter is back.

## 4. Manual verification

- [ ] 4.1 Run `npm run dev` (or `npm run tauri dev`) with two `postgres-table-data` tabs open on different relations, each with its own non-empty filter. Confirm switching between them shows each tab's own filter on first paint, with no flash of the other tab's filter. _(Pending live smoke; covered by automated test 3.1.)_
- [ ] 4.2 Confirm `Open in SQL Editor` from a table viewer with a non-empty applied filter opens the editor pre-populated with the `SELECT * FROM ... WHERE ... LIMIT N` SQL. Repeat from a tab with an empty filter — the editor should open with `SELECT * FROM ... LIMIT N` (no WHERE). _(Pending live smoke; covered by automated tests 2.3 + 2.4.)_
- [ ] 4.3 Close a query tab and confirm the `pgQueryBuffer:<tabId>` settings key is removed (inspect the settings store or rely on the test from 2.4 as proxy). _(Covered by automated test 2.4.)_

## 5. Spec sync and validation

- [x] 5.1 Run `openspec validate fix-stale-tab-state --strict --type change` and address any drift.
- [x] 5.2 Run the full test suite (`npx vitest run`) and `npx tsc --noEmit`. Both must pass.
- [x] 5.3 No DESIGN.md changes expected — this is purely state-management plumbing.
