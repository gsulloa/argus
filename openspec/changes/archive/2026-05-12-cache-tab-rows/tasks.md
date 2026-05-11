## 1. Tab shell: keep-mounted rendering

- [x] 1.1 Read `src/platform/shell/tabs/TabContent.tsx` and `TabsContext.tsx` to confirm current single-tab render flow.
- [x] 1.2 In `TabContent.tsx`, track a `Set<string>` of "ever-activated" tab IDs in component state. Update it in an effect that watches `activeTabId`; add the active id on every change, never remove (removal happens in 1.3).
- [x] 1.3 Prune the "ever-activated" set when a tab is no longer present in `tabs[]` (closed tabs disappear from the DOM and free memory).
- [x] 1.4 Render one `<div>` per ever-activated tab inside the root. The active tab's container uses the existing layout; non-active containers get an `aria-hidden="true"` attribute and a CSS class that applies `display: none`. Add the class to `TabContent.module.css`.
- [x] 1.5 Inside each container, render `<Renderer tab={tab} active={tab.id === activeTabId} />`. Use `key={tab.id}` on the container so React preserves instances on reorder.
- [x] 1.6 Update the `TabRegistry` renderer type signature to `(props: { tab: Tab; active: boolean }) => ReactNode`. Adjust the type definitions in `TabRegistry.ts` and any registration call sites.
- [x] 1.7 Verify the empty-state branch (no tabs) and the unknown-kind fallback still render correctly when the active id is `null`.

## 2. Renderer audit: gate window-level side-effects on `active`

- [x] 2.1 Grep the codebase for `window.addEventListener`, `document.addEventListener`, and Tauri `listen(`/`getCurrent().listen(` calls inside files under `src/modules/**` and `src/platform/**`. Build a list of every registration that lives in a tab renderer or in a hook reachable from one.
- [x] 2.2 For each registration, decide: (a) gate by `active` (re-attach when active flips true, detach when false), (b) move the listener to the tab's own container element, or (c) leave it alone if it is safe to fire while hidden (e.g. truly global app-level listener that belongs in the shell, not in a tab).
- [x] 2.3 Update `TableViewerTab` to accept and respect the `active` prop. Gate any `window`/`document` keyboard listeners on `active`. Verify `Cmd+1`/`Cmd+2`/`Cmd+3` only fire for the active tab.
- [x] 2.4 Update `QueryTab` to accept and respect the `active` prop. Gate the Run shortcut and any global keyboard handlers on `active`.
- [x] 2.5 Audit other tab kinds (`welcome`, `postgres-object-placeholder`, `query-history`, `activity-log`, anything else found via `TabRegistry.register` call sites) and update their renderer signatures to accept `active`; gate listeners as needed.

## 3. Data grid: confirm no refetch on activation

- [x] 3.1 Read `useTableData.ts:296-300` and confirm the fetch effect's dependencies (`enabled`, `state.status.state`, `state.generation`, `fetchFirstPage`) do not change merely because the parent visibility toggled. They should not — but add a console-instrumented dev assertion behind `import.meta.env.DEV` if uncertain.
- [x] 3.2 Verify `depsKey` (`useTableData.ts:220`) is unaffected by mount/visibility cycles. No code change expected.
- [x] 3.3 Confirm `globalSchemaCache` is unaffected (it already caches across tabs).

## 4. Grid resize and DOM-visibility quirks

- [x] 4.1 Identify the virtualization library / component used in the data grid; check its docs for behavior on `display: none` → `display: block` transitions.
- [x] 4.2 If the grid does not auto-recompute on un-hide, attach a `ResizeObserver` (or use the existing one) to trigger a re-measure when the container transitions back to visible. Implement as a small effect in `TableViewerTab` keyed on `active`.
- [x] 4.3 Verify the filter bar's input does not steal focus on un-hide (no `autoFocus` firing). If it does, gate the auto-focus on first mount only.

## 5. SQL editor: confirm result retention

- [x] 5.1 Read `QueryTab.tsx` and `useQueryRun.ts` to confirm the result lives in component state (no remount = no loss). No code change expected beyond the `active` prop wiring from task 2.4.
- [x] 5.2 Verify CodeMirror retains its document, selection, scroll, and undo history when its parent toggles `display: none` and back. CodeMirror 6 normally handles this; if not, add a focus restoration effect keyed on `active`.

## 6. Memory and cleanup

- [x] 6.1 Verify closing a tab unmounts its renderer (task 1.3 verification): open a table tab, take a memory snapshot in dev tools, close the tab, snapshot again, confirm the rows array is GC'd.
- [x] 6.2 Confirm no setTimeout/setInterval is left running by a closed tab's effects (none expected; verify via Chrome DevTools Performance tab).

## 7. QA (manual)

- [x] 7.1 Open five different table tabs against a live local Postgres. Cycle through all five with ⌃Tab. Open the activity log. Verify zero new `query_table` or `count_table` events appear during the cycle.
- [x] 7.2 For each table tab: scroll partway, select a row, edit a cell without applying, switch away, switch back. Verify scroll position, selected row, and pending edit indicator all survive.
- [x] 7.3 Apply a filter on a returned-to tab; verify a fresh `query_table` event fires and rows are replaced.
- [x] 7.4 Close a table tab, reopen the same relation from the schema browser; verify a fresh fetch (first-time-open behavior), with no carry-over from the closed tab.
- [x] 7.5 Open three query tabs, run a query in each, switch among them; verify each result panel persists and no re-run occurs.
- [x] 7.6 Start a long-running query (`SELECT pg_sleep(5); SELECT 1;`), switch to another tab while it runs, switch back; verify the elapsed-time indicator continued and the result is rendered when the query completes.
- [x] 7.7 Test keyboard shortcuts: with two table tabs open, focus tab B, press `Cmd+2`; verify only tab B switches to Structure subtab.
- [x] 7.8 Test the welcome tab and any other non-table tab kinds for regressions.

## 8. Spec sync

- [x] 8.1 After QA passes, run `openspec apply cache-tab-rows` (or follow the project's archive workflow) to merge spec deltas into `openspec/specs/{app-shell,postgres-data-grid,postgres-sql-editor}/spec.md`.
- [x] 8.2 Update `openspec/ROADMAP.md` if appropriate to note the change.
