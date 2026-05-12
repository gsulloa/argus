## MODIFIED Requirements

### Requirement: Pending update applies on app quit

Once a download completes, the updater MUST hold the update in a pending state. By default the update SHALL be applied when the user quits the app (by ⌘Q, closing the last window, or restart): quit → apply update → next launch starts on the new version. In addition, the user MAY explicitly trigger apply-and-relaunch mid-session via the "Install update & restart" action (see "User can apply pending update without quitting"); when invoked, the same `install()` call runs and the app process is relaunched onto the new binary immediately. Outside of an explicit user-triggered install, no mid-session swap of the running binary is allowed — background download alone MUST NOT relaunch the app.

#### Scenario: Quit applies pending update

- **WHEN** an update has finished downloading and the user quits the app
- **THEN** the new version replaces the old binary on disk before the process exits, and the next launch runs the new version

#### Scenario: No pending update means normal quit

- **WHEN** the user quits with no update pending
- **THEN** the app exits normally with no extra delay or apply step

#### Scenario: Background download alone does not relaunch

- **WHEN** an update finishes downloading and the user takes no action
- **THEN** the app continues running the current version with no relaunch, no modal, and no banner; the pending state is held until quit or until the user invokes "Install update & restart"

## ADDED Requirements

### Requirement: User can apply pending update without quitting

The frontend SHALL expose an "Install update & restart" action that is visible only when an update has been downloaded and is held pending. When invoked, the action MUST call the pending `Update.install()` and then relaunch the app process via the Tauri `process` plugin's `relaunch()` API, so that the new version is running without requiring the user to manually quit. The action MUST NOT be visible when no update is pending.

#### Scenario: Pending update shows the install-and-restart action

- **WHEN** an update has finished downloading in the background and the user opens the version dropdown in the status bar
- **THEN** an "Install update & restart" menu item is shown above the "Skip" and "Clear skipped version" items

#### Scenario: No pending update hides the action

- **WHEN** no update is pending (either none is available, or the available version is skipped, or the download has not yet completed)
- **THEN** the "Install update & restart" menu item is not rendered in the version dropdown

#### Scenario: Clicking the action installs and relaunches

- **WHEN** the user clicks "Install update & restart" with a pending v0.1.7
- **THEN** the pending update's `install()` runs to completion, the app process is relaunched, and the relaunched window reports `v0.1.7` as the current version

### Requirement: Install-and-restart is guarded against double-invocation

The install-and-restart action MUST be idempotent within a single app session. While an install is in flight, the action MUST be disabled (or otherwise non-actionable) and a concurrent quit-time apply MUST NOT run a second `install()` call. The same in-memory pending `Update` reference MUST be used by both the user-triggered path and the quit-time path.

#### Scenario: Rapid double-click runs install once

- **WHEN** the user clicks "Install update & restart" twice in quick succession
- **THEN** exactly one `Update.install()` call is made and exactly one relaunch is initiated

#### Scenario: User quits while install is in progress

- **WHEN** the user clicks "Install update & restart" and then quits the app before the install completes
- **THEN** the `beforeunload` quit-time handler observes the in-flight install guard and does NOT initiate a second `install()` call; the in-progress install completes once and the app exits cleanly

#### Scenario: Failed install allows retry

- **WHEN** `Update.install()` rejects (e.g., disk full, permission error) during a user-triggered install-and-restart
- **THEN** the error is logged, the in-flight guard is released, the action becomes clickable again, and the pending update is still available to retry or to apply on quit

### Requirement: Install-and-restart uses the Tauri process plugin with a narrow capability

The Rust app SHALL include `tauri-plugin-process` v2 as a dependency and register it in the Tauri builder. The frontend SHALL invoke restart via `@tauri-apps/plugin-process`'s `relaunch()`. The Tauri capability file MUST grant only `process:allow-restart` (or an equivalent narrow scope) and MUST NOT grant the broader `process:default` or `process:allow-exit`, so the frontend cannot terminate the app without going through the install path.

#### Scenario: Relaunch capability is granted

- **WHEN** the app is built and launched
- **THEN** the frontend's call to `relaunch()` succeeds when invoked from the install-and-restart action

#### Scenario: Exit capability is not granted

- **WHEN** the frontend attempts to call `process.exit()` (the broader API)
- **THEN** the call is rejected by Tauri's capability system because `process:allow-exit` is not granted
