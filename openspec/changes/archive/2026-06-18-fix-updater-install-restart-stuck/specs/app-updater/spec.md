## ADDED Requirements

### Requirement: User-triggered restart bypasses the ExitRequested install-guard

When `updater_install_and_restart` is about to call `app.restart()`, it MUST signal the `RunEvent::ExitRequested` handler that the upcoming exit is part of a deliberate relaunch and not a user-initiated quit. The signal MUST be a process-wide flag (e.g., `relaunching: AtomicBool` on `UpdaterState`) set BEFORE clearing the `installing` flag, so any quit racing between the two writes still observes an intercepting state. The `ExitRequested` handler MUST check this relaunch flag FIRST, before evaluating `has_pending` / `installing`. When the flag is set, the handler MUST NOT call `api.prevent_exit()` and MUST NOT block on any wait loop — it MUST return immediately so Tauri's native restart sequence proceeds. The relaunch flag is one-shot per process lifetime and is NOT cleared by either the success or error paths of `app.restart()`.

#### Scenario: Successful install-and-restart actually relaunches the app

- **WHEN** the user clicks "Install update & restart" with a pending update, `update.install()` returns `Ok(())`, and `app.restart()` is invoked
- **THEN** the `ExitRequested` handler observes `relaunching = true`, returns without calling `api.prevent_exit()`, the process exits and Tauri immediately re-spawns the binary; the relaunched window reports the new version as current

#### Scenario: Exit handler emits a verifiable log line on the relaunch path

- **WHEN** the relaunching flag short-circuits the `ExitRequested` handler
- **THEN** a `tracing` event with `target = "updater"` and message `relaunch_allowed_by_exit_handler` is recorded BEFORE the process exits, and that line appears in the output of `updater_logs_tail`

#### Scenario: User-triggered install failure does not arm the relaunch flag

- **WHEN** the user clicks "Install update & restart" and `update.install()` returns `Err`
- **THEN** the `relaunching` flag remains `false`, the pending update is restored to state, `installing` is cleared, the renderer receives the error, and any subsequent user-quit follows the normal pending-install-on-quit path

## MODIFIED Requirements

### Requirement: Pending update applies on app quit

Once a download completes, the updater MUST hold the pending update handle in Rust-side state. By default, the update SHALL be applied when the user quits the app (by ⌘Q, closing the last window, or restart). The apply MUST run from a Tauri `RunEvent::ExitRequested` hook (not from a renderer `beforeunload` handler) so the process exit is deterministically blocked until the on-disk binary swap completes. The install step MUST run with a 10-second timeout; on timeout the failure is logged via `tracing::error!` with `target=updater` and the app exits anyway (the user retains their intent to quit; the update is re-applied on a later cycle). In addition, the user MAY explicitly trigger apply-and-relaunch mid-session via the "Install update & restart" action (see "User can apply pending update without quitting"). Outside of an explicit user-triggered install, no mid-session swap of the running binary is allowed — background download alone MUST NOT relaunch the app. The `ExitRequested` handler MUST check the `relaunching` flag FIRST (see "User-triggered restart bypasses the ExitRequested install-guard") and return immediately when set; only when `relaunching` is false does the handler evaluate `has_pending` / `installing` and decide whether to apply-on-quit, wait-for-in-flight-install, or allow normal exit.

#### Scenario: Quit applies pending update before process exits

- **WHEN** an update has finished downloading and the user quits the app
- **THEN** the `RunEvent::ExitRequested` hook observes `relaunching = false`, then `has_pending = true && installing = false`, calls `api.prevent_exit()`, runs `update.install()` to completion, then calls `app.exit(0)`; the next launch runs the new version

#### Scenario: Install timeout during quit does not block exit forever

- **WHEN** the user quits with a pending update and `update.install()` does not complete within 10 seconds
- **THEN** the timeout is logged as `tracing::error!` with `target=updater`, `app.exit(0)` is called, and the app exits; the pending update remains undeployed and is re-downloaded on the next check

#### Scenario: No pending update means normal quit

- **WHEN** the user quits with no pending update and no relaunch in flight
- **THEN** the `ExitRequested` hook observes `relaunching = false`, `has_pending = false`, `installing = false`, allows normal exit with no extra delay

#### Scenario: Background download alone does not relaunch

- **WHEN** an update finishes downloading and the user takes no action
- **THEN** the app continues running the current version with no relaunch, no modal, and no banner; the pending state is held in Rust until quit or until the user invokes "Install update & restart"

#### Scenario: Relaunch-flag short-circuit takes precedence over apply-on-quit

- **WHEN** `app.restart()` raises an `ExitRequested` event from the user-triggered install path (pending is already empty, installing is in the process of being cleared, and `relaunching = true`)
- **THEN** the handler returns without calling `api.prevent_exit()`, does NOT enter the apply-on-quit branch, does NOT enter the wait-for-install branch, and allows Tauri's restart sequence to complete

### Requirement: User can apply pending update without quitting

The frontend SHALL expose an "Install update & restart" action that is visible only when an update has been downloaded and is held pending. When invoked, the action MUST call a single Rust command `updater_install_and_restart` that (1) takes the pending `Update` from Tauri state, (2) runs `update.install().await`, (3) sets the `relaunching` flag and clears the `installing` flag, (4) calls `app.restart()`. The order of operations in step 3 MUST be: set `relaunching = true` FIRST, then clear `installing = false`, so any concurrent quit racing the two writes still observes an intercepting state. The entire sequence MUST run in Rust so the renderer's webview teardown cannot race the install or relaunch steps. The action MUST NOT be visible when no update is pending.

#### Scenario: Pending update shows the install-and-restart action

- **WHEN** an update has finished downloading in the background and the user opens the version dropdown in the status bar
- **THEN** an "Install update & restart" menu item is shown above the "Skip" and "Clear skipped version" items

#### Scenario: No pending update hides the action

- **WHEN** no update is pending (either none is available, or the available version is skipped, or the download has not yet completed)
- **THEN** the "Install update & restart" menu item is not rendered in the version dropdown

#### Scenario: Clicking the action installs and relaunches via Rust

- **WHEN** the user clicks "Install update & restart" with a pending v0.1.9
- **THEN** the renderer invokes `updater_install_and_restart`; the Rust command logs `install_started`, runs `install()` to completion, logs `install_complete`, sets `relaunching = true`, clears `installing = false`, logs `relaunch_invoked`, then calls `app.restart()`; the `ExitRequested` handler short-circuits via the `relaunching` flag, logs `relaunch_allowed_by_exit_handler`, and the relaunched window reports `v0.1.9` as the current version

#### Scenario: Install-and-restart failure surfaces to the user

- **WHEN** the user clicks "Install update & restart" and `update.install()` returns an error (e.g., disk full, permission denied, signature mismatch)
- **THEN** the Rust command emits `tracing::error!` with `target=updater` and the full error chain, leaves the `relaunching` flag unset, restores the pending `Update` to state, clears `installing`, returns `Err(message)` to the renderer, and the renderer surfaces a user-visible toast or inline error chip labeled "Install failed — view logs" that links to the in-app logs viewer

### Requirement: Updater milestones emit structured tracing events

The updater pipeline MUST emit a `tracing` event at every milestone with `target = "updater"`. Required milestones (each as its own event): `check_started`, `check_complete` (with `available: bool`, `version: Option<String>`), `version_skipped` (with `version`), `download_started` (with `version`), `download_complete` (with `version`), `install_started` (with `version`, `trigger: "quit" | "user_action"`), `install_complete` (with `version`), `relaunch_invoked`, `relaunch_allowed_by_exit_handler` (emitted by the `ExitRequested` handler when the `relaunching` flag short-circuits intercept logic), and an error event for each failure path. Renderer-originated state transitions (e.g., user clicked skip, user opened the logs viewer) MUST also be logged by invoking a Rust command `log_updater_event(level, msg, fields)` so they land in the same log file under the same target.

#### Scenario: Successful update cycle emits a full event trail

- **WHEN** a pending update is detected, downloaded, and the user installs-and-restarts
- **THEN** `argus.log` contains, in order, events for `check_started`, `check_complete`, `download_started`, `download_complete`, `install_started`, `install_complete`, `relaunch_invoked`, `relaunch_allowed_by_exit_handler`, each tagged `target=updater`

#### Scenario: Renderer-originated event reaches the log file

- **WHEN** the user clicks "Skip vX.Y.Z" in the version dropdown
- **THEN** the renderer invokes `log_updater_event` with `level=info` and a `version_skipped_by_user` message; `argus.log` contains a corresponding line tagged `target=updater`

#### Scenario: Quit-path apply does not emit relaunch events

- **WHEN** the user quits with a pending update and the quit-path apply succeeds (no user-triggered restart)
- **THEN** `argus.log` contains `install_started` (with `trigger=quit`) and `install_complete`, but does NOT contain `relaunch_invoked` or `relaunch_allowed_by_exit_handler` for that cycle
