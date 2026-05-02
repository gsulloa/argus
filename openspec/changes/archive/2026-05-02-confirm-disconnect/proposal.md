## Why

Closing a Postgres connection is currently a single click on the same row that opens it. That symmetry is wrong: opening is cheap (handshake + warm cache), closing is expensive (open table-viewer tabs are killed, dirty edit buffers are silently discarded, schema cache is dropped). Worse, while a slow connect is in flight an impatient second click flips through `active=true` and triggers an immediate disconnect, costing the user state they did not intend to lose.

## What Changes

- **BREAKING** Clicking on an already-active connection row no longer disconnects it. The row click on an active row is a no-op; the row click on a connecting row is also a no-op.
- A dedicated `⏻` Disconnect button is rendered on every active row, always visible (not hover-only), to the left of the existing `⋮` toolbar slot.
- Pressing `⏻` opens a confirmation dialog before disconnecting. The dialog body adapts to what is at risk: a single line when nothing is open, a tab-count line when tabs are open, and a strong warning line when there are unsaved edit buffers — each unsaved buffer is named (table + connection).
- The dialog reuses the existing `useCloseConfirm` registry to discover dirty buffers.
- A new "Disconnect all" affordance is added to the Connections section header (visible only when ≥1 connection is active). It opens the same confirmation dialog with aggregated counts across all active connections.
- A new backend Tauri command `postgres.disconnect_all` removes every registered pool in one call and emits a single aggregated `argus:activity-log` entry plus one `postgres:active-changed` event.
- While `postgres.connect` is in flight for a given row, the row enters a `connecting` visual state (spinner where the active dot sits) and ignores further clicks until the call resolves.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `postgres-connection`: Disconnect now requires a dedicated trigger (not the connect/disconnect row toggle) and a confirmation step. New `disconnect_all` command.

## Impact

- Frontend
  - `src/platform/shell/Sidebar.tsx` — `ConnectionRow` click semantics; new `⏻` button; new connecting visual state; section-header "Disconnect all" affordance.
  - `src/platform/shell/Sidebar.module.css` — styles for `⏻`, connecting state.
  - `src/modules/postgres/api.ts` + `src/modules/postgres/commands.ts` — wire `disconnect_all` Tauri command.
  - Reuse `src/platform/shell/tabs/useCloseConfirm.ts` to detect dirty buffers; may need a small read-only API (`listDirtyTabs(connectionId)`) since today the registry only answers per-tab.
- Backend
  - `src-tauri/src/modules/postgres/pool.rs` — add `PgPoolRegistry::disconnect_all`.
  - `src-tauri/src/modules/postgres/commands.rs` + `src-tauri/src/lib.rs` — register `postgres_disconnect_all` command, emit activity-log + `active-changed` event.
- No DB migrations. No changes to secrets or settings storage.
- No keyboard shortcut for Disconnect-all in this change (deferred).
