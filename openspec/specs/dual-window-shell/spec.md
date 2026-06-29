# dual-window-shell Specification

## Purpose
TBD - created by archiving change add-dual-window-shell. Update Purpose after archive.
## Requirements
### Requirement: Two window roles

The application SHALL run as two windows with fixed roles: a **Connection Manager** window (label `manager`) and a single **Workspace** window (label `workspace`). Both windows load the same bundle; each mounts a role-specific UI determined by its window label. There MUST be at most one Workspace window at any time.

#### Scenario: Manager opens at cold start

- **WHEN** the user launches Argus with no running instance
- **THEN** exactly one window opens, the Connection Manager (label `manager`)
- **AND** no Workspace window exists and no connection is automatically opened

#### Scenario: Only one Workspace window exists

- **WHEN** a Workspace window already exists and the user opens another connection from the Manager
- **THEN** no second Workspace window is created; the existing Workspace is reused

#### Scenario: Role is determined by window label

- **WHEN** a window with label `manager` finishes loading
- **THEN** it renders the Connection Manager UI
- **AND** a window with label `workspace` renders the Workspace UI

### Requirement: Shared backend across windows

Both windows SHALL invoke the same Tauri commands against the shared backend registries (SQLite, connection pools, keychain, context watchers). Opening a connection that is already open in one window MUST reuse its existing pool rather than creating a second one.

#### Scenario: Pool is reused, not duplicated

- **WHEN** a connection is open and the user triggers "open" for the same connection again
- **THEN** the backend reuses the existing pool for that connection id (no second pool is created)

#### Scenario: Backend events reach both windows

- **WHEN** a connection's open/closed state changes
- **THEN** both the Manager and the Workspace (if present) receive the `connections:open-changed` event

### Requirement: Open-connections source of truth

The backend SHALL maintain a cross-engine registry of currently-open connections and expose it via a `connections_open_list()` command returning each open connection's id, kind, and name. On every connect or disconnect, the backend MUST emit a `connections:open-changed` event carrying the updated list to all windows. The Manager SHALL render each connection's open/closed state from this source, and the Workspace SHALL build its rail from this source.

#### Scenario: Listing open connections on demand

- **WHEN** two connections are open and a window calls `connections_open_list()`
- **THEN** the result contains exactly those two connections with their id, kind, and name

#### Scenario: Workspace rebuilds the rail on spawn

- **WHEN** three connections are already open and the Workspace window is (re)created
- **THEN** the Workspace calls `connections_open_list()` and shows all three in its rail, not only the connection that triggered the spawn

#### Scenario: Manager reflects open state live

- **WHEN** a connection becomes open or is closed
- **THEN** the Manager updates that connection's open/closed indicator without a manual refresh

### Requirement: Open-and-focus coordination

The Manager SHALL open a connection into the Workspace through a single `workspace_open_connection(id)` command that: (1) ensures the connection is open (connecting if necessary), (2) ensures the Workspace window exists (creating it with label `workspace` if absent), (3) focuses the Workspace window, and (4) causes the Workspace to add the connection to its rail and make it the focused connection. The operation MUST be idempotent for an already-open, already-railed connection.

#### Scenario: Opening the first connection spawns the Workspace

- **WHEN** no Workspace window exists and the user opens a connection from the Manager
- **THEN** the connection is opened, a Workspace window is created and focused, and that connection becomes the focused connection in the rail

#### Scenario: Opening a second connection adds it to the rail and focuses it

- **WHEN** a Workspace window exists with one connection open and the user opens a different connection from the Manager
- **THEN** the Workspace is focused, the new connection is added to the rail, and it becomes the focused connection

#### Scenario: Opening an already-open connection just focuses it

- **WHEN** a connection is already open and present in the rail and the user opens it again from the Manager
- **THEN** no duplicate rail entry is created
- **AND** the Workspace is focused and that connection becomes the focused connection

### Requirement: Window lifecycle rules

The two windows SHALL follow fixed lifecycle rules. Closing the Workspace MUST disconnect ALL open connections and then reveal and focus the Manager. When more than one connection is open at the time of closing, the Workspace MUST first present a confirmation prompt stating how many connections will be disconnected; if the user cancels, the close MUST be aborted and the Workspace MUST remain open with all its connections untouched. When zero or one connection is open, the Workspace MUST close without a prompt. Closing the Manager while a Workspace exists MUST keep the Workspace running. Closing the Manager when no Workspace exists MUST terminate the application (subject to host-platform conventions).

#### Scenario: Closing the Workspace with one connection disconnects it and returns to the Manager

- **WHEN** the Workspace window is open with exactly one connection open and the user closes it
- **THEN** no confirmation prompt is shown
- **AND** that connection is disconnected
- **AND** the Workspace window is destroyed and the Manager window is shown and focused

#### Scenario: Closing the Workspace with multiple connections prompts for confirmation

- **WHEN** the Workspace window is open with two or more connections open and the user closes it
- **THEN** a confirmation prompt appears stating how many connections will be disconnected

#### Scenario: Confirming the prompt disconnects all and returns to the Manager

- **WHEN** the confirmation prompt is shown and the user confirms
- **THEN** all open connections are disconnected
- **AND** the Workspace window is destroyed and the Manager window is shown and focused

#### Scenario: Cancelling the prompt aborts the close

- **WHEN** the confirmation prompt is shown and the user cancels
- **THEN** the Workspace window remains open
- **AND** all connections remain open and untouched

#### Scenario: Closing the Manager keeps an existing Workspace

- **WHEN** both windows exist and the user closes the Manager
- **THEN** the Manager window is destroyed and the Workspace continues running unaffected

#### Scenario: Closing the Manager with no Workspace quits the app

- **WHEN** only the Manager window exists and the user closes it
- **THEN** the application terminates cleanly on Windows and Linux
- **AND** on macOS the process MAY remain alive per platform convention and recreate the Manager on dock activation

### Requirement: Forced schema-reload accelerator

The Workspace window SHALL register a global `Cmd+R` (macOS) / `Ctrl+R` (other platforms) keyboard accelerator that forces a reload of the **focused** connection's schema/table tree. The handler MUST resolve the focused connection's engine and trigger that engine's existing refresh path — dropping the connection's schema/table cache entry and re-fetching — identical in effect to activating that connection's tree refresh button. The handler MUST call `preventDefault` so the native webview reload does not fire. When no connection is focused, the accelerator MUST be a no-op (it MUST still suppress the native reload). The accelerator MUST NOT fire while the user is typing in an input or textarea.

#### Scenario: Cmd+R reloads the focused connection's tree

- **WHEN** a connection is focused in the rail and the user presses `Cmd+R` / `Ctrl+R`
- **THEN** that connection's schema/table cache is dropped and its tree re-fetches
- **AND** the native webview reload does not occur

#### Scenario: Cmd+R with no focused connection is a safe no-op

- **WHEN** no connection is focused and the user presses `Cmd+R` / `Ctrl+R`
- **THEN** no refresh is triggered
- **AND** the native webview reload is still suppressed

#### Scenario: Accelerator routes to the focused engine

- **WHEN** the focused connection is a Postgres connection and the user presses `Cmd+R`
- **THEN** only the Postgres refresh path runs for that connection
- **AND** switching focus to a DynamoDB connection and pressing `Cmd+R` runs the DynamoDB refresh path instead

### Requirement: Workspace identity header exposes per-engine contextual actions

The Workspace sidebar identity header SHALL render the focused connection's per-engine contextual actions inline in a dedicated, right-aligned actions slot, dispatched by the connection's engine kind. The actions presented MUST match the engine's capabilities and reuse the same action components as the rest of the app (single source of truth — no engine-specific action is reimplemented for the header):

- **PostgreSQL** — New SQL query, Refresh schemas, and a visible-schemas picker.
- **MySQL** — New SQL query, Refresh databases, and a visible-schemas picker.
- **MSSQL** — New SQL query, Refresh, and a visible-schemas picker.
- **Athena** — New SQL query and Refresh.
- **DynamoDB** — Refresh tables.

Engine kinds with no defined header actions (e.g. `cloudwatch`) SHALL render no actions slot content and MUST NOT error. The header MUST update reactively when the focused connection changes, showing the newly-focused connection's actions. Triggering a header action MUST have the same effect as triggering the corresponding action elsewhere in the app (e.g. "New SQL query" opens a new query tab bound to the focused connection).

#### Scenario: Postgres connection shows query, refresh, and schema picker

- **WHEN** a PostgreSQL connection is focused in the Workspace
- **THEN** the identity header shows a New SQL query action, a Refresh action, and a visible-schemas picker
- **AND** clicking New SQL query opens a new query tab bound to that connection

#### Scenario: DynamoDB connection shows only refresh

- **WHEN** a DynamoDB connection is focused in the Workspace
- **THEN** the identity header shows a Refresh tables action
- **AND** it shows no SQL-query or visible-schemas actions

#### Scenario: Athena connection shows query and refresh, no schema picker

- **WHEN** an Athena connection is focused in the Workspace
- **THEN** the identity header shows a New SQL query action and a Refresh action
- **AND** it shows no visible-schemas picker

#### Scenario: Engine without header actions renders cleanly

- **WHEN** a connection whose engine kind has no defined header actions (e.g. `cloudwatch`) is focused in the Workspace
- **THEN** the identity header renders the connection identity with no action controls and without error

#### Scenario: Actions follow focus changes

- **WHEN** the focused connection changes from one engine to another (e.g. Postgres to DynamoDB)
- **THEN** the identity header replaces the previous engine's actions with the newly-focused connection's actions

### Requirement: Workspace identity header shows the AWS region for DynamoDB connections

The Workspace sidebar identity header SHALL display the active AWS region of a focused **DynamoDB** connection as connection metadata, rendered in the existing identity metadata row (alongside the engine label and the environment indicator dot). The region MUST be the focused connection's **runtime** region as reported by the active connection (`ActiveDynamoConnection.region`). When the connection is not currently active, the header SHALL fall back to the region configured in the connection's params (`DynamoParams.region`). When no region can be resolved from either source, the header MUST render no region content and MUST NOT error or show an empty placeholder.

The region content MUST follow `DESIGN.md` (typography, spacing, color of the header metadata row) and read as quiet metadata, not as a prominent badge. This requirement applies only to the `dynamodb` engine kind; the identity header of all other engine kinds MUST be unchanged.

#### Scenario: Active DynamoDB connection shows its runtime region

- **WHEN** a DynamoDB connection that is currently active in region `us-east-1` is focused in the Workspace
- **THEN** the identity header shows `us-east-1` in the identity metadata row
- **AND** it still shows the DynamoDB engine label and the environment indicator dot

#### Scenario: Region reflects the active connection, not stale form input

- **WHEN** a DynamoDB connection is active in region `us-west-2`
- **THEN** the identity header shows `us-west-2`
- **AND** the displayed region matches the region the app is querying against

#### Scenario: Inactive DynamoDB connection falls back to configured region

- **WHEN** a DynamoDB connection that is not currently active is focused, and its params specify region `eu-central-1`
- **THEN** the identity header shows `eu-central-1` from the connection params

#### Scenario: No region available renders cleanly

- **WHEN** a focused DynamoDB connection has no resolvable region from the active connection or its params
- **THEN** the identity header renders the connection identity without any region content and without error

#### Scenario: Non-DynamoDB engines show no region

- **WHEN** a focused connection is any engine kind other than DynamoDB (e.g. Postgres, MySQL, MSSQL, Athena, CloudWatch)
- **THEN** the identity header does not show an AWS region added by this change

### Requirement: Connection Manager has a fixed window size

The Connection Manager window (label `manager`) SHALL open at a single fixed size from every creation path and MUST NOT be resizable by the user. The fixed size MUST be identical whether the window is created at cold start or recreated after being closed. Persisted window state MUST NOT override the Manager's fixed size on subsequent launches. The Workspace window (label `workspace`) is unaffected and SHALL remain resizable with its geometry persisted across sessions.

#### Scenario: Manager opens at the fixed size at cold start

- **WHEN** the application starts and the Connection Manager window opens
- **THEN** its inner size is exactly the canonical fixed size (760×600)
- **AND** the window exposes no resize affordance

#### Scenario: Manager reopens at the fixed size after being closed

- **WHEN** the Manager window was closed and is then recreated (e.g. via `ensure_manager_window`)
- **THEN** the recreated window opens at the same canonical fixed size (760×600)
- **AND** it is not resizable

#### Scenario: User cannot resize the Manager window

- **WHEN** the user attempts to drag any edge or corner of the Manager window
- **THEN** the window dimensions do not change

#### Scenario: Persisted state does not override the fixed Manager size

- **WHEN** a saved window-state profile records a different Manager size from before this change
- **AND** the application launches and opens the Manager
- **THEN** the Manager opens at the canonical fixed size, not the persisted size

#### Scenario: Workspace remains resizable

- **WHEN** the user resizes the Workspace window and later relaunches the application
- **THEN** the Workspace window is resizable and reopens at its last persisted size

