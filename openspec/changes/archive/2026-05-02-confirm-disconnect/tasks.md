## 1. Backend: disconnect_all command

- [x] 1.1 Add `PgPoolRegistry::disconnect_all(&self) -> usize` in `src-tauri/src/modules/postgres/pool.rs` that snapshots active ids under the write lock, drains all entries, and returns the count dropped.
- [x] 1.2 Add unit tests in the same file: empty-registry returns 0; populated registry drops everything and subsequent `list_active` is empty.
- [x] 1.3 Add Tauri command `postgres_disconnect_all` in `src-tauri/src/modules/postgres/commands.rs` that calls `disconnect_all`, emits exactly one `postgres:active-changed` event when N > 0, and emits exactly one `argus:activity-log` event with `kind: "disconnect"`, `connection_id: null`, `metric` carrying the dropped count, `status: "ok"`, and `duration_ms` covering the command. When N = 0, suppress both events.
- [x] 1.4 Register `postgres_disconnect_all` in the Tauri builder in `src-tauri/src/lib.rs`.

## 2. Frontend API surface

- [x] 2.1 Add `disconnectAll()` to `postgresApi` in `src/modules/postgres/api.ts` returning the dropped count.
- [x] 2.2 Re-export from `src/modules/postgres/commands.ts` and `src/modules/postgres/index.ts` if needed for the sidebar import path. (`postgresApi` already re-exported from `index.ts`; no extra wiring needed.)

## 3. Dirty-buffer summary registry

- [x] 3.1 In `src/platform/shell/tabs/useCloseConfirm.ts` (or a sibling file `useDirtySummary.ts`), add a registry keyed by `tabId` storing `{ connectionId: string, label: string } | null`. Provide `useDirtySummary(tabId, summary)` to register/unregister on mount/unmount and `listDirtySummaries(connectionId)` to query.
- [x] 3.2 Wire `TableViewerTab` (and any other tab kind with edit buffers) to call `useDirtySummary` when its buffer is dirty, with `label` set to the table name.
- [x] 3.3 Add unit tests covering register/unregister, querying by connection id, and that a clean buffer reports nothing.

## 4. Connection tab enumeration

- [x] 4.1 Expose `listConnectionTabs(connectionId)` from the tabs registry so the disconnect dialog can count tabs that belong to a connection. If the registry already exposes this via `useTabs`, document it and skip the addition.
- [x] 4.2 Add a unit/integration test that asserts the count for a fixture set of tabs.

## 5. Sidebar: row click semantics and connecting state

- [x] 5.1 In `src/platform/shell/Sidebar.tsx::ConnectionRow`, replace the connect/disconnect toggle with: inactive → connect; active → no-op; connecting → no-op.
- [x] 5.2 Track `isConnecting` as local state, set when `postgresApi.connect` is dispatched, cleared on resolve/reject.
- [x] 5.3 Render a small spinner in place of the active dot while connecting; preserve the existing dot when active or inactive.
- [x] 5.4 Update `title` / `aria-label` to reflect the new semantics ("Connect" on inactive, none/connection name on active).

## 6. Sidebar: per-row Disconnect button + dialog

- [x] 6.1 Add a `⏻` button to `ConnectionRow`, rendered only when active, always visible (not hover-only), placed left of `SchemaToolbar`. Style via `Sidebar.module.css`.
- [x] 6.2 Add a `DisconnectConfirmDialog` component (in `src/platform/shell/` alongside the Delete dialog) that takes `{ open, onOpenChange, connectionName, tabCount, dirtyTables, onConfirm }`. Reuse `dialogStyles` from `Dialog.module.css`.
- [x] 6.3 Wire `⏻` click to open the dialog with counts derived from `listConnectionTabs` and `listDirtySummaries`. On confirm, dispatch `postgresApi.disconnect(connectionId)` and close the dialog.
- [x] 6.4 Verify the dialog body composes the three lines per spec (heading always; tab count when ≥1; strong warning + table list when ≥1 dirty).

## 7. Sidebar: Disconnect-all affordance

- [x] 7.1 In `ConnectionsSection`, render a Disconnect-all button in the section header next to `+`, visible only when at least one connection is active. Use a clear icon (e.g. `PowerOff` from lucide).
- [x] 7.2 Reuse `DisconnectConfirmDialog` with aggregated props: `connectionName` becomes a connection-count summary, `tabCount` aggregates across all active connections, `dirtyTables` lists `<connection>.<table>` strings.
- [x] 7.3 On confirm, dispatch `postgresApi.disconnectAll()` exactly once.

## 8. QA and visual verification

- [x] 8.1 With one active connection, confirm clicking the row body does nothing; confirm the impatient-double-click during connect no longer disconnects after the first click resolves.
- [x] 8.2 With dirty edit buffers, confirm the dialog names the table and the strong-warning line is visible.
- [x] 8.3 With multiple active connections, confirm Disconnect-all aggregates correctly and only one activity-log entry / one `active-changed` event is produced (verify via the Activity Log panel).
- [x] 8.4 Confirm zero regressions in the existing Delete-connection flow (its dialog and behavior must remain unchanged).
- [x] 8.5 Open `design/preview.html` and verify the new `⏻` button and busy spinner respect `DESIGN.md` (no thick borders, correct accent, correct radii).

## 9. Spec validation

- [x] 9.1 Run `openspec validate confirm-disconnect --strict` and resolve any structural errors.
- [x] 9.2 Spot-check that every scenario in `specs/postgres-connection/spec.md` maps to a test or QA step above.
