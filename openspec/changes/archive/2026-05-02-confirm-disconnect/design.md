## Context

Today the sidebar's `ConnectionRow` (`src/platform/shell/Sidebar.tsx:122`) treats the row as a connect/disconnect toggle: clicking an inactive row calls `postgresApi.connect`, clicking an active row calls `postgresApi.disconnect`. Disconnect tears down everything that hangs off an active connection — table-viewer tabs, schema cache, schema-tree subtree, and any in-memory dirty edit buffers tracked by `useEditBuffer` — without consulting the existing `useCloseConfirm` registry that protects individual tabs from accidental close.

A second failure mode sits inside this same toggle: while `postgresApi.connect` is in flight, `active` is still `false`, but the moment the backend resolves and the `postgres:active-changed` event flips the row to active, an impatient second click fires `postgresApi.disconnect`. Users lose state without any signal that they did anything at all.

Backend disconnect itself is healthy (`src-tauri/src/modules/postgres/pool.rs:136` — graceful pool drop, in-flight queries complete) and remains unchanged. The fix is entirely about the UI affordance and a small new aggregate command.

## Goals / Non-Goals

**Goals:**
- Make disconnect impossible to trigger by an accidental row click, including during a slow connect.
- Always interpose a confirmation step before a disconnect actually runs, with a body that adapts to what is at stake.
- Provide a single "Disconnect all" affordance with the same confirmation contract.
- Reuse the existing `useCloseConfirm` plumbing rather than inventing a parallel "is this dirty" registry.

**Non-Goals:**
- Persisting tab state across disconnect/reconnect (out of scope; today they are gone forever, and that does not change).
- Keyboard shortcut for Disconnect-all (deferred — easy to add later, not justified now).
- Showing the `⏻` icon on inactive rows as "nothing to do" affordance — the active dot already conveys state.
- Backgrounding or queueing in-flight queries on disconnect — the existing backend contract ("in-flight queries MUST be allowed to complete") already covers this.

## Decisions

### D1: Disconnect lives on a dedicated `⏻` button, not on the row click

The row click toggle is replaced with: row click on inactive → connect; row click on active → no-op; row click on connecting → no-op. A `⏻` (power) button is rendered on every active row, always visible, sitting to the left of the existing `⋮`/`SchemaToolbar` slot.

**Alternatives considered:**
- *Hover-only icon*: more visually quiet, but the user explicitly asked for always-visible.
- *Keep the toggle but require double-click to disconnect*: hidden gesture, undiscoverable, still vulnerable to the impatient-click race.
- *Hold-to-disconnect on the dot*: same discoverability problem.

### D2: Confirmation dialog is always shown, body adapts

Pressing `⏻` always opens a `Dialog.Root` (mirroring the existing Delete dialog pattern at `src/platform/shell/Sidebar.tsx:232`). The body composes from up to three lines:

- "Disconnect `<name>`?" (always)
- "N tab(s) will close." (when N ≥ 1)
- "⚠ M unsaved edit(s) will be discarded:" followed by a small list of `<table>` names (when M ≥ 1)

When nothing is open the dialog still shows — predictability beats cleverness here, and the cost of one extra click is negligible compared to the cost of an accidental disconnect. The footer is `[Cancel] [Disconnect]`; the primary action is destructive-styled.

**Alternatives considered:**
- *Skip dialog when nothing is at risk*: rejected — makes behavior depend on hidden state and reintroduces "easy disconnect" for the common case.
- *Toast with undo*: undoing a disconnect would require re-establishing the pool and re-opening tabs from a snapshot; too expensive for this change.

### D3: Dirty-buffer detection reuses `useCloseConfirm`

Today `useCloseConfirm` (`src/platform/shell/tabs/useCloseConfirm.ts:42`) is a per-tab close interceptor. Tabs with dirty edit buffers register a handler. We extend it minimally:

- Add `listConnectionTabs(connectionId)` (returns the set of tab ids belonging to a connection) — sourced from the tab registry, not the close-handler map.
- Add a synchronous `isDirty(tabId)` API that the close handler optionally exposes; or, simpler, walk the tab registry, collect tabs for the connection, and ask each renderer to provide a `getDirtySummary()` via a new optional registration.

Most likely shape: a new `useDirtySummary(tabId, summary)` hook that components like `TableViewerTab` call alongside `useCloseConfirm`, writing into a parallel registry keyed by `tabId`. The disconnect dialog reads it.

**Alternatives considered:**
- *A global "dirty store" the edit buffers push into*: more invasive; couples disconnect to edit-buffer internals.
- *Only count dirty tabs without naming the table*: weaker UX — naming the table makes the warning concrete.

### D4: New backend command `postgres.disconnect_all`

Mirrors `postgres.disconnect` but operates over the entire `PgPoolRegistry`:

- Snapshot the set of active ids under the registry's write lock, drain them all, drop locks.
- Emit one `argus:activity-log` entry with `kind: "disconnect"`, `connection_id: null`, `metric: { kind: "count", value: N }` (or repurpose an existing metric kind), `status: "ok"`.
- Emit `postgres:active-changed` once at the end.

The frontend dialog calls this command rather than looping per-id `postgres.disconnect` to avoid N events and N activity-log rows.

**Alternatives considered:**
- *Loop `postgres.disconnect` from the frontend*: simpler, but produces N activity-log rows and N `active-changed` events for a single user gesture.

### D5: Connecting state is local UI state, not backend state

`ConnectionRow` tracks an `isConnecting` flag locally: set when `postgresApi.connect` is called, cleared when the promise resolves or rejects. While true, the row's click handler is no-op and the `activeDot` is replaced with a small spinner. No backend changes required — `postgres.connect` is already idempotent.

**Alternatives considered:**
- *Lift connecting state into `useActiveConnections`*: nice for cross-component consistency, but only the row needs it today.

## Risks / Trade-offs

- [Risk] Users who relied on click-to-disconnect get confused → Mitigation: the new `⏻` icon is always visible and labelled via `title` / `aria-label`. Activity-log breadcrumbs unchanged.
- [Risk] `useCloseConfirm` extension grows into a parallel state-management system → Mitigation: keep the new dirty-summary registry tiny (set of `(tabId, summary)` pairs); document its single consumer (the disconnect dialog) so it does not metastasize.
- [Risk] `disconnect_all` race with concurrent per-id disconnects → Mitigation: the registry's write lock already serializes `disconnect` and `disconnect_all`; whichever wins, the other becomes a no-op.
- [Trade-off] Confirming when nothing is at risk costs one click for the no-state case. Accepted as the cost of predictability.

## Open Questions

None at proposal time. If implementation reveals that "list connection tabs" is awkward to expose from the current tabs registry, we will revisit D3 and may pivot to a global dirty-store approach (D3 alternative) — captured in `tasks.md` as a checkpoint.
