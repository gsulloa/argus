## 1. SubtabHeader: accept Reload control (all three engines)

- [x] 1.1 Update `src/modules/postgres/structure/SubtabHeader.tsx` to accept three new optional props: `onReload?: () => void`, `reloadDisabled?: boolean`, `reloading?: boolean`. Render a `<button>` with the lucide `RotateCw` icon (size 13, strokeWidth 2) immediately after the existing Filter toggle, gated on `active === "data" && onReload !== undefined`. The button's `disabled` attribute MUST mirror `reloadDisabled`; the icon container MUST receive `className={styles.reloadIcon}` and a `data-spinning={reloading ? "true" : "false"}` attribute. Title: `"Reload (⌘R)"`. `aria-label`: `"Reload"`.
- [x] 1.2 Update `src/modules/postgres/structure/SubtabHeader.module.css` to add `.reloadIcon[data-spinning="true"]` → `animation: spin 1s linear infinite;` and a matching `@keyframes spin { to { transform: rotate(360deg); } }`. Match the existing `.filterToggle` button shape (same padding, border, hover background) so the two buttons read as a pair.
- [x] 1.3 Repeat 1.1 in `src/modules/mysql/structure/SubtabHeader.tsx` and 1.2 in `src/modules/mysql/structure/SubtabHeader.module.css`. Verify the prop names exactly match Postgres — the spec calls for cross-engine API parity.
- [x] 1.4 Repeat 1.1 in `src/modules/mssql/structure/SubtabHeader.tsx` and 1.2 in `src/modules/mssql/structure/SubtabHeader.module.css`.

## 2. Postgres: wire Reload into TableViewerTab

- [x] 2.1 In `src/modules/postgres/data/TableViewerTab.tsx`, define a stable `onReload` callback near the existing Apply handlers (line ~564): `const onReload = useCallback(() => setApplyToken((t) => t + 1), []);`.
- [x] 2.2 Compute `reloadDisabled` as `data.status === "loading-first" || data.status === "loading-first-retrying"`, and `reloading` as the same boolean (button shows spinning state whenever it's disabled by an in-flight first-page fetch). Pass `onReload`, `reloadDisabled`, and `reloading` to `<SubtabHeader>` at line ~613.
- [x] 2.3 Extend the existing `useEffect` keyboard handler (lines 469–552) to handle `(e.metaKey || e.ctrlKey) && e.key === "r" && !e.shiftKey && !e.altKey`. Inside: if `document.activeElement?.closest(".cm-editor")` return early; otherwise `e.preventDefault()` and call `onReload()`. Place the branch BEFORE the existing ⌘F branch (so ⌘R doesn't fall through). Add `onReload` to the effect dependency array.
- [x] 2.4 Verify the existing root-contains-focus guard (`if (!root.contains(document.activeElement)) return;`) does NOT block ⌘R when a filter-bar input has focus — those inputs are inside `rootRef`, so they pass the guard. Confirm by manual test: focus a filter input, press ⌘R, expect a refetch.

## 3. MySQL: wire Reload into TableViewerTab

- [x] 3.1 In `src/modules/mysql/data/TableViewerTab.tsx`, pass `onReload={tableData.refresh}`, `reloadDisabled={tableData.isLoading}`, `reloading={tableData.isLoading}` to `<SubtabHeader>` at line ~448.
- [x] 3.2 Add a `useEffect` keyboard handler (or `useShortcuts` call if the module already uses it elsewhere) that, while `active === true`, listens for `(metaKey || ctrlKey) && key === "r" && !shiftKey && !altKey`. Inside: if focus is in `.cm-editor`, return. Otherwise `preventDefault()` and call `tableData.refresh()`. Mirror the structure of the Postgres ⌘R branch from task 2.3.
- [x] 3.3 If MySQL TableViewerTab does NOT currently receive an `active` prop equivalent to Postgres's, fall back to a global handler — but verify only one MySQL tab fires the refetch (use `useTabs().activeTabId === tabId` or equivalent) so background tabs stay quiet.

## 4. MSSQL: wire Reload into TableViewerTab

- [x] 4.1 In `src/modules/mssql/data/TableViewerTab.tsx`, pass `onReload={tableData.refresh}`, `reloadDisabled={tableData.isLoading}`, `reloading={tableData.isLoading}` to `<SubtabHeader>` at line ~405.
- [x] 4.2 Same as 3.2 / 3.3 for MSSQL: add a ⌘R handler that calls `tableData.refresh()`, with the CodeMirror guard and `preventDefault()`. Gate on the active-tab check.

## 5. Manual smoke test (all three engines)

- [x] 5.1 Postgres: open a table, apply a filter, press ⌘R → verify the network panel shows a new `postgres_query_table` IPC call AND filter values are preserved.
- [x] 5.2 MySQL: open a table, apply a filter, click the Reload icon → verify `mysql_query_table` fires and filter values are preserved.
- [x] 5.3 MSSQL: open a table, apply a filter, press ⌘R → verify `mssql_query_table` fires and filter values are preserved.
- [x] 5.4 For each engine: open two tabs, activate the second, press ⌘R, verify only the second tab refetches.
- [x] 5.5 For each engine: focus a CodeMirror surface (raw SQL panel, AI chat panel) and press ⌘R → verify the table does NOT refetch and the editor's own ⌘R behavior is preserved (or nothing happens, depending on editor binding).
- [x] 5.6 For each engine: while a first-page fetch is in flight, click Reload → verify the button is disabled and clicks have no effect; verify the icon visibly spins.
- [x] 5.7 For each engine: type into a filter input and press ⌘R → verify the input value is not cleared and the refetch fires.
- [x] 5.8 For each engine: with uncommitted edits in the buffer, click Reload → verify the edit buffer survives (dirty indicators stay; insert rows remain at top).
- [x] 5.9 Verify ⌘R never triggers a full window reload in any case (no white flash, no Tauri webview reset).

## 6. Validation

- [x] 6.1 Run `openspec validate add-reload-button-table-data-grid` and resolve any reported issues.
- [x] 6.2 Run `pnpm typecheck` (or the project's TypeScript check command — discover via `package.json` scripts) and resolve any new errors.
- [x] 6.3 Run the existing MySQL/MSSQL refresh tests (`pnpm test -- useTableData.refresh`) and verify they still pass. No new test files required — the hooks are untouched.
- [x] 6.4 Re-read `DESIGN.md` and verify the Reload icon button matches Argus's visual language (icon-only, monospace tooltip, no accent gradient).
