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

