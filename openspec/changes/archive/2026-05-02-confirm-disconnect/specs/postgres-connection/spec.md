## MODIFIED Requirements

### Requirement: Sidebar Postgres connection rows

The sidebar's "Connections" section SHALL render each Postgres connection as a row containing a Postgres icon, the connection name, a status indicator (green dot when `useActiveConnections()` reports the id as connected, neutral dot when inactive, spinner while a connect call is in flight), and an "RO" badge when `params.read_only` is true.

The row's primary click handler SHALL behave as follows: on an inactive row it initiates `postgres.connect`; on a row whose connection is in flight (`postgres.connect` not yet resolved) it is a no-op; on an active row it performs no destructive action (no-op or non-destructive subtree affordance). The row click MUST NOT dispatch `postgres.disconnect`.

Disconnect MUST be reachable only from a dedicated `⏻` (power) button rendered on every active row, always visible (not hover-only) and sized to be a deliberate target distinct from the row body, or from the row's right-click context menu's `Disconnect` entry, or from the section-level "Disconnect all" affordance.

Right-clicking a row opens a context menu. On an active row the menu includes `New SQL Query`, `Disconnect`, then a separator, then `Edit`, `Duplicate`, and `Delete`. On an inactive row the menu includes only `Edit`, `Duplicate`, and `Delete`.

#### Scenario: Click on an inactive row connects

- **WHEN** the user clicks an inactive connection row
- **THEN** `postgres.connect(id)` is invoked; on success the active indicator turns green

#### Scenario: Click on an active row does not disconnect

- **WHEN** the user clicks the body of a connection row whose connection is currently active
- **THEN** no `postgres.disconnect` command is dispatched and the active state of the connection is unchanged

#### Scenario: Click on a connecting row does not disconnect or re-connect

- **WHEN** the user clicks the body of a connection row while `postgres.connect` for that row is still pending
- **THEN** no additional `postgres.connect` or `postgres.disconnect` is dispatched until the in-flight call resolves

#### Scenario: Disconnect button is always visible on active rows

- **WHEN** any connection is active in the sidebar
- **THEN** that row renders a `⏻` button regardless of hover state, with a `title`/`aria-label` of "Disconnect"

#### Scenario: Disconnect button is hidden on inactive rows

- **WHEN** a connection is not active
- **THEN** the row does not render a `⏻` button

#### Scenario: RO badge visible when read-only

- **WHEN** a connection has `params.read_only: true`
- **THEN** the row displays an "RO" badge next to the name

#### Scenario: Right-click context menu on active row

- **WHEN** the user right-clicks an active connection row
- **THEN** a menu appears with `New SQL Query`, `Disconnect`, `Edit`, `Duplicate`, and `Delete`; choosing `Edit` opens the form prefilled with the connection's params and an empty password field

#### Scenario: Right-click context menu on inactive row

- **WHEN** the user right-clicks an inactive connection row
- **THEN** a menu appears with `Edit`, `Duplicate`, and `Delete`

#### Scenario: Delete confirmation

- **WHEN** the user chooses `Delete` from the context menu and confirms
- **THEN** `connections.delete(id)` is invoked, the row disappears, and any active pool for that id is dropped via `postgres.disconnect`

## ADDED Requirements

### Requirement: Disconnect requires a confirmation step

Activating the per-row `⏻` Disconnect button SHALL open a confirmation dialog before any `postgres.disconnect` is dispatched. The dialog MUST always be shown (it MUST NOT be skipped when there is no apparent state at risk). The dialog body MUST adapt to what is open for that connection at the moment the dialog opens:

- A "Disconnect `<name>`?" heading line is always present.
- When one or more tabs belong to that connection, a "N tab(s) will close." line is shown with the exact count.
- When one or more dirty edit buffers belong to that connection, a strong-warning line "M unsaved edit(s) will be discarded:" is shown followed by the list of affected `<table>` names. The strong-warning line MUST be visually distinct from the tab-count line.

The dialog footer MUST present a non-destructive Cancel action and a destructive-styled Disconnect action. Cancel MUST close the dialog without dispatching any command. Disconnect MUST dispatch `postgres.disconnect(connectionId)` and close the dialog.

The dialog MUST source the dirty-buffer summary from the same registry that gates per-tab close confirmation; a tab whose close confirmation reports clean MUST NOT contribute a "unsaved edit" line.

#### Scenario: Confirm shows even with nothing at risk

- **WHEN** the user clicks `⏻` on an active connection that has zero open tabs and zero dirty buffers
- **THEN** the confirmation dialog opens with only the heading line and a [Cancel] [Disconnect] footer
- **AND** no `postgres.disconnect` is dispatched until Disconnect is clicked

#### Scenario: Confirm lists tab count when tabs are open

- **WHEN** the user clicks `⏻` on a connection that has 3 open tabs and zero dirty buffers
- **THEN** the dialog body includes a line stating "3 tabs will close."

#### Scenario: Confirm warns and names tables when buffers are dirty

- **WHEN** the user clicks `⏻` on a connection that has 2 open tabs, of which 1 has a dirty edit buffer for the `users` table
- **THEN** the dialog body includes "2 tabs will close." and a separate strong-warning line "1 unsaved edit will be discarded:" followed by `users`

#### Scenario: Cancel does not disconnect

- **WHEN** the confirmation dialog is open and the user clicks Cancel
- **THEN** no `postgres.disconnect` is dispatched and the dialog closes

#### Scenario: Disconnect proceeds and closes the dialog

- **WHEN** the confirmation dialog is open and the user clicks Disconnect
- **THEN** `postgres.disconnect(connectionId)` is dispatched exactly once and the dialog closes

### Requirement: Connecting visual state ignores further clicks

While `postgres.connect` is in flight for a given connection row, the row SHALL display a busy indicator in place of the active dot (a spinner or equivalent) and its primary click handler MUST be a no-op. The busy state begins when `postgres.connect` is dispatched and ends when the promise resolves or rejects.

#### Scenario: Connecting row shows a busy indicator

- **WHEN** the user clicks an inactive connection row and `postgres.connect` is dispatched
- **THEN** until the call resolves, the row's active dot is replaced with a busy indicator

#### Scenario: Click during connecting is a no-op

- **WHEN** the user clicks the body of a row that is in the connecting state
- **THEN** no additional `postgres.connect` or `postgres.disconnect` is dispatched

### Requirement: Disconnect-all command and trigger

The sidebar Connections section header SHALL render a "Disconnect all" affordance that is visible only when at least one connection is active. Activating it MUST open the same confirmation dialog defined for per-row disconnect, with the body aggregating across every active connection: total connection count, total tab count across those connections, and a strong-warning line when any of those tabs has a dirty edit buffer (listing each affected `<connection>.<table>` pair).

The Postgres module SHALL expose a Tauri command `postgres.disconnect_all()` that snapshots the set of currently active pool ids under the registry's write lock, removes all of them, and returns the number of pools that were dropped. After the command completes the module SHALL emit exactly one `postgres:active-changed` event and exactly one `argus:activity-log` event with `kind: "disconnect"`, `connection_id: null`, `origin: "user"`, `status: "ok"`, `duration_ms` covering the whole command, `sql: null`, `params: null`, and a metric describing the count of dropped pools.

The frontend "Disconnect all" Disconnect action MUST dispatch `postgres.disconnect_all()` once rather than looping per-id `postgres.disconnect` calls.

#### Scenario: Disconnect-all affordance hidden when no connection is active

- **WHEN** zero connections are active
- **THEN** the Connections section header does not render a Disconnect-all affordance

#### Scenario: Disconnect-all affordance visible when one or more are active

- **WHEN** at least one connection is active
- **THEN** the Connections section header renders a Disconnect-all affordance with a `title`/`aria-label` of "Disconnect all"

#### Scenario: Disconnect-all dialog aggregates counts

- **WHEN** the user activates Disconnect-all with 3 active connections that together have 5 open tabs and 1 dirty buffer for `analytics.users`
- **THEN** the confirmation dialog shows the connection count, "5 tabs will close.", and a strong-warning line listing `analytics.users`

#### Scenario: Disconnect-all dispatches one command

- **WHEN** the user confirms the Disconnect-all dialog with 3 active connections
- **THEN** exactly one `postgres.disconnect_all()` Tauri command is dispatched
- **AND** zero per-id `postgres.disconnect()` commands are dispatched as part of this gesture

#### Scenario: disconnect_all removes all pools

- **WHEN** the backend receives `postgres.disconnect_all()` with 3 registered pools
- **THEN** all 3 pools are removed from `PgPoolRegistry` and `postgres.list_active()` subsequently returns an empty list

#### Scenario: disconnect_all emits one active-changed event

- **WHEN** `postgres.disconnect_all()` completes successfully with N ≥ 1 pools dropped
- **THEN** exactly one `postgres:active-changed` event is emitted

#### Scenario: disconnect_all emits one activity-log entry

- **WHEN** `postgres.disconnect_all()` completes with N pools dropped
- **THEN** exactly one `argus:activity-log` event is emitted with `kind: "disconnect"`, `status: "ok"`, `connection_id: null`, and a metric whose value equals N

#### Scenario: disconnect_all with no active pools is a no-op

- **WHEN** `postgres.disconnect_all()` is invoked while `PgPoolRegistry` is empty
- **THEN** the command returns 0, no `postgres:active-changed` event is emitted, and no `argus:activity-log` event is emitted
