## MODIFIED Requirements

### Requirement: Pending update applies on app quit

Once a download completes, the updater MUST hold the pending update handle in Rust-side state. By default, the update SHALL be applied when the user quits the app (by ⌘Q, closing the last window, or restart). The apply MUST run from a Tauri `RunEvent::ExitRequested` hook (not from a renderer `beforeunload` handler) so the process exit is deterministically blocked until the on-disk binary swap completes. The install step MUST run with a 10-second timeout; on timeout the failure is logged via `tracing::error!` with `target=updater` and the app exits anyway (the user retains their intent to quit; the update is re-applied on a later cycle). In addition, the user MAY explicitly trigger apply-and-relaunch mid-session via the "Install update & restart" action (see "User can apply pending update without quitting"). Outside of an explicit user-triggered install, no mid-session swap of the running binary is allowed — background download alone MUST NOT relaunch the app.

#### Scenario: Quit applies pending update before process exits

- **WHEN** an update has finished downloading and the user quits the app
- **THEN** the `RunEvent::ExitRequested` hook calls `api.prevent_exit()`, runs `update.install()` to completion, then calls `app.exit(0)`; the next launch runs the new version

#### Scenario: Install timeout during quit does not block exit forever

- **WHEN** the user quits with a pending update and `update.install()` does not complete within 10 seconds
- **THEN** the timeout is logged as `tracing::error!` with `target=updater`, `app.exit(0)` is called, and the app exits; the pending update remains undeployed and is re-downloaded on the next check

#### Scenario: No pending update means normal quit

- **WHEN** the user quits with no pending update
- **THEN** the `ExitRequested` hook observes empty updater state and allows normal exit with no extra delay

#### Scenario: Background download alone does not relaunch

- **WHEN** an update finishes downloading and the user takes no action
- **THEN** the app continues running the current version with no relaunch, no modal, and no banner; the pending state is held in Rust until quit or until the user invokes "Install update & restart"

### Requirement: User can apply pending update without quitting

The frontend SHALL expose an "Install update & restart" action that is visible only when an update has been downloaded and is held pending. When invoked, the action MUST call a single Rust command `updater_install_and_restart` that (1) takes the pending `Update` from Tauri state, (2) runs `update.install().await`, (3) calls `app.restart()`. The entire sequence MUST run in Rust so the renderer's webview teardown cannot race the install or relaunch steps. The action MUST NOT be visible when no update is pending.

#### Scenario: Pending update shows the install-and-restart action

- **WHEN** an update has finished downloading in the background and the user opens the version dropdown in the status bar
- **THEN** an "Install update & restart" menu item is shown above the "Skip" and "Clear skipped version" items

#### Scenario: No pending update hides the action

- **WHEN** no update is pending (either none is available, or the available version is skipped, or the download has not yet completed)
- **THEN** the "Install update & restart" menu item is not rendered in the version dropdown

#### Scenario: Clicking the action installs and relaunches via Rust

- **WHEN** the user clicks "Install update & restart" with a pending v0.1.9
- **THEN** the renderer invokes `updater_install_and_restart`; the Rust command logs `install_started`, runs `install()` to completion, logs `install_complete`, logs `relaunch_invoked`, then calls `app.restart()`; the relaunched window reports `v0.1.9` as the current version

#### Scenario: Install-and-restart failure surfaces to the user

- **WHEN** the user clicks "Install update & restart" and `update.install()` returns an error (e.g., disk full, permission denied, signature mismatch)
- **THEN** the Rust command emits `tracing::error!` with `target=updater` and the full error chain, returns `Err(message)` to the renderer, and the renderer surfaces a user-visible toast or inline error chip labeled "Install failed — view logs" that links to the in-app logs viewer

### Requirement: Install-and-restart is guarded against double-invocation

The install-and-restart action MUST be idempotent within a single app session. While an install is in flight, the action MUST be disabled in the UI and the Rust command MUST refuse a second concurrent invocation by returning a no-op `Ok(())` if it observes an in-flight install. The same Rust-side pending `Update` reference MUST be used by both the user-triggered command and the quit-time `ExitRequested` hook; whichever runs first wins, and the second observes the empty state and is a no-op.

#### Scenario: Rapid double-click runs install once

- **WHEN** the user clicks "Install update & restart" twice in quick succession
- **THEN** exactly one `Update.install()` call is made and exactly one `app.restart()` is initiated

#### Scenario: User quits while install is in progress

- **WHEN** the user clicks "Install update & restart" and then quits the app before the install completes
- **THEN** the `ExitRequested` hook observes the pending state is already taken (or that an install is in flight) and does NOT initiate a second `install()` call; the in-progress install completes once and the app restarts cleanly

#### Scenario: Failed install allows retry

- **WHEN** `Update.install()` rejects during a user-triggered install-and-restart
- **THEN** the error is logged, the pending `Update` is returned to state (so it remains available), the renderer surfaces the error, and the action becomes clickable again

### Requirement: Update errors do not crash or block the app

Any failure in the updater pipeline (network error, signature failure, disk full, manifest parse error, install error, relaunch error) MUST be caught and logged via `tracing` with `target=updater` at the appropriate level (`warn` for transient network issues, `error` for install/signature/relaunch failures). Errors at the **check** and **download** stages MUST NOT surface as a blocking dialog or interrupt the user's session; the app continues running its current version and retries on the next periodic check. Errors at the **user-triggered install-and-restart** stage MUST surface to the user as a non-blocking notification (toast or inline chip) that points the user to the in-app logs viewer, because the user took an explicit action and is owed feedback.

#### Scenario: Network failure during check is silent

- **WHEN** the updater endpoint returns a 500 or times out
- **THEN** the user sees no error, the failure is logged with `target=updater` at `warn` level, and the next periodic check retries

#### Scenario: Manifest parse error is logged

- **WHEN** the fetched `latest.json` is malformed
- **THEN** an `error`-level event is recorded in the log with `target=updater`, no update is attempted, and the app continues normally

#### Scenario: User-triggered install failure is surfaced

- **WHEN** the user clicks "Install update & restart" and the underlying install or relaunch fails
- **THEN** the failure is logged with `target=updater` at `error` level AND a non-blocking notification appears in the UI directing the user to the logs viewer

### Requirement: Updater milestones emit structured tracing events

The updater pipeline MUST emit a `tracing` event at every milestone with `target = "updater"`. Required milestones (each as its own event): `check_started`, `check_complete` (with `available: bool`, `version: Option<String>`), `version_skipped` (with `version`), `download_started` (with `version`), `download_complete` (with `version`), `install_started` (with `version`, `trigger: "quit" | "user_action"`), `install_complete` (with `version`), `relaunch_invoked`, and an error event for each failure path. Renderer-originated state transitions (e.g., user clicked skip, user opened the logs viewer) MUST also be logged by invoking a Rust command `log_updater_event(level, msg, fields)` so they land in the same log file under the same target.

#### Scenario: Successful update cycle emits a full event trail

- **WHEN** a pending update is detected, downloaded, and the user installs-and-restarts
- **THEN** `argus.log` contains, in order, events for `check_started`, `check_complete`, `download_started`, `download_complete`, `install_started`, `install_complete`, `relaunch_invoked`, each tagged `target=updater`

#### Scenario: Renderer-originated event reaches the log file

- **WHEN** the user clicks "Skip vX.Y.Z" in the version dropdown
- **THEN** the renderer invokes `log_updater_event` with `level=info` and a `version_skipped_by_user` message; `argus.log` contains a corresponding line tagged `target=updater`
