## 1. Reproduce and instrument

- [x] 1.1 Reproduce Mode A: open a saved query with no `last_connection_id` while no connection is focused → confirm nothing happens (no tab, no warning). *(Confirmed by code trace: `openSavedQuery` → `openQueryTab` → `tabs.open()` where `extractConnectionId(payload) ?? focusedConnectionId` is `null` → `return ""`.)*
- [x] 1.2 Reproduce Mode B: focus connection A, open a saved query bound to live connection B → confirm the tab lands in B's hidden set and nothing appears. *(Confirmed by code trace: `open()` keys the tab to B's `ConnectionTabSet` but never calls `setFocused`, so the strip keeps rendering A's set.)*
- [x] 1.3 Add a temporary log/assert in `TabsContext.open()` at the `return ""` branch to confirm it is the swallow point during repro. *(Skipped as unnecessary — the `return ""` swallow point is confirmed by reading `TabsContext.open()` at line 141–144; no throwaway logging added.)*

## 2. Switch focus when opening a saved query (Decision 1)

- [x] 2.1 Thread the focused-connection API (`setFocused`) and the open-connections set into the saved-query open flow — either pass them as params to `openSavedQuery` / `openSavedQueryInNew`, or resolve them in `SavedQueriesPanel` before calling. *(New `OpenSavedQueryCtx` param `{ focusedConnectionId, setFocused, isOpen }`; panel resolves via `useFocusedConnection()` + `useOpenConnections()`.)*
- [x] 2.2 In `openSavedQuery` / `openSavedQueryInNew` (`modules/saved-queries/openSavedQuery.ts`): when `last_connection_id` resolves to a connection that is currently **open**, call `setFocused(connId)` before `tabs.open()`.
- [x] 2.3 Ensure focus is switched first, then the tab is opened, so the new tab is created in the now-visible set and becomes active.
- [x] 2.4 Apply the same logic uniformly across Postgres (`openQueryTab`), MySQL (`openMysqlQueryTab`), and MSSQL (`openMssqlQueryTab`) routes by centralizing focus resolution in the shared entry points. *(Centralized in `openSavedQueryImpl`.)*

## 3. Fallback for no-live-connection (Decision 2)

- [x] 3.1 When `last_connection_id` is null/unknown/not-open but a connection is focused, open the tab against the focused connection with an empty connection selector (Postgres) — verify this is deterministic. *(Fallback branch; `initialConnectionId: undefined` → `tabs.open()` resolves to `focusedConnectionId`.)*
- [x] 3.2 Verify MySQL/MSSQL saved queries whose connection is not live still route sensibly (fallback or clear message), matching the spec. *(Not-open connections fall through to the focused-connection fallback / `no-target` toast, same as any non-live connection. Note: opening a not-open MySQL/MSSQL query while focused on another engine uses the documented Postgres fallback — pre-existing behavior, unchanged.)*

## 4. Remove the silent dead end (Decision 3)

- [x] 4.1 In `SavedQueriesPanel` open/activate handler, detect the "no live query connection AND no focused connection" case and surface an affordance (toast/inline hint like "Focus a connection to open this query") instead of calling into a no-op. *(`handleOpenSaved` shows toast "Open or focus a connection to open this saved query." on `"no-target"`.)*
- [x] 4.2 Confirm `TabsContext.open()` is never reached with an unresolvable target from the saved-query flow (guard remains, but is unreachable via this path). *(The `no-target` branch returns before any `tabs.open()` call; guard in `open()` left intact.)*

## 5. Cleanup

- [x] 5.1 Update the stale "tabs are now connection-agnostic" comment in `openQueryTab.ts` to describe the actual per-connection model (Decision 4).

## 6. Tests

- [x] 6.1 Unit/integration test: opening a query bound to a non-focused live connection switches focus and surfaces the tab (spec scenario: "Opening a query bound to a non-focused connection surfaces its tab"). *(`openSavedQuery.test.ts` — Postgres/MySQL/MSSQL live-connection variants assert `setFocused` called + correct helper.)*
- [x] 6.2 Unit/integration test: opening a query with no live connection while a connection is focused opens against the focused connection (spec scenario).
- [x] 6.3 Unit/integration test: opening a query with no resolvable connection and no focus surfaces an affordance and is not silently dropped (spec scenario). *(Asserts `"no-target"` returned + no tab opened; toast wiring in panel.)*
- [x] 6.4 Test for `app-shell` scenario: opening a tab for a non-focused connection switches focus and shows that connection's set. *(Covered at the open-flow layer via the `setFocused`-called assertions; `TabsContext` per-connection scoping unchanged and covered by existing `connectionTabs.test.ts`.)*
- [x] 6.5 Regression: existing per-connection tab scoping scenarios still pass. *(Full suite: 1550 passed, 0 failed.)*

## 7. Verify

- [x] 7.1 Manual QA: run the app, exercise Mode A and Mode B repro steps from section 1 and confirm both now surface the query. *(Confirmed manually by user.)*
- [x] 7.2 `/qa` and design review of any new affordance against `DESIGN.md`. *(Confirmed manually by user; only new UI is a transient info toast.)*
