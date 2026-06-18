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

### Requirement: Install-and-restart uses the Tauri process plugin with a narrow capability

The Rust app SHALL include `tauri-plugin-process` v2 as a dependency and register it in the Tauri builder. The frontend SHALL invoke restart via `@tauri-apps/plugin-process`'s `relaunch()`. The Tauri capability file MUST grant only `process:allow-restart` (or an equivalent narrow scope) and MUST NOT grant the broader `process:default` or `process:allow-exit`, so the frontend cannot terminate the app without going through the install path.

#### Scenario: Relaunch capability is granted

- **WHEN** the app is built and launched
- **THEN** the frontend's call to `relaunch()` succeeds when invoked from the install-and-restart action

#### Scenario: Exit capability is not granted

- **WHEN** the frontend attempts to call `process.exit()` (the broader API)
- **THEN** the call is rejected by Tauri's capability system because `process:allow-exit` is not granted
