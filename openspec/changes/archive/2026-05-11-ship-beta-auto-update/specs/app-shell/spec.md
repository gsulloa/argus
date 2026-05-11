## ADDED Requirements

### Requirement: Status bar displays current app version

The status bar SHALL display the current app version on its right-hand side at all times, in muted text styled per `DESIGN.md` (the existing neutral/secondary text color, not an accent). The version string MUST be obtained at runtime via `getVersion()` from `@tauri-apps/api/app` so it always reflects the binary that is actually running. The version display MUST persist across all tabs, all panel states, and all connection states — it is never hidden or replaced.

#### Scenario: Version visible on first launch

- **WHEN** the user launches Argus Beta v0.1.5 for the first time
- **THEN** the status bar's right side shows `v0.1.5` in muted text

#### Scenario: Version visible regardless of layout state

- **WHEN** the inspector is collapsed, expanded, the bottom panel is open, or any tab is active
- **THEN** the version string remains visible in the status bar

#### Scenario: Version reflects the running binary, not config files

- **WHEN** the running app is v0.1.5 but `package.json` on disk says `0.1.6` (mid-release race)
- **THEN** the status bar still shows `v0.1.5` because it reads from the Tauri runtime, not from package.json

### Requirement: Status bar surfaces pending update state

When the auto-updater has downloaded a new version that will apply on next quit, the status bar version display MUST visually indicate the pending update by appending the target version in the accent color (e.g. `v0.1.5 → v0.1.7`). A tooltip on hover MUST explain "Restart Argus Beta to apply v0.1.7". When no update is pending, only the current version is shown.

#### Scenario: No pending update shows current version only

- **WHEN** no update has been downloaded yet
- **THEN** the status bar shows `v0.1.5` with no arrow or second version

#### Scenario: Pending update shows arrow and target version

- **WHEN** the updater has finished downloading v0.1.7 and is waiting for quit to apply
- **THEN** the status bar shows `v0.1.5 → v0.1.7` with the second version in the accent color

#### Scenario: Tooltip explains pending state

- **WHEN** the user hovers over `v0.1.5 → v0.1.7`
- **THEN** a tooltip appears with text "Restart Argus Beta to apply v0.1.7"

#### Scenario: After restart, pending indicator clears

- **WHEN** the user quits, the update applies, and the app relaunches as v0.1.7
- **THEN** the status bar shows `v0.1.7` with no arrow until a newer version is detected

### Requirement: Version display offers an actions menu

Clicking the version string in the status bar MUST open a dropdown menu with the following actions, in this order: "Check for updates now" (forces an immediate updater check), "Skip this version" (only enabled and visible when an update is pending or available; persists skip per the app-updater capability), "Clear skipped version" (only enabled and visible when a skip is currently active), and "About Argus Beta" (opens an about modal showing version, identifier, build commit, and a link to the release notes URL on R2).

#### Scenario: Menu opens on click

- **WHEN** the user clicks the version string in the status bar
- **THEN** a dropdown menu appears anchored to that element

#### Scenario: Skip option only when relevant

- **WHEN** there is no pending or available update
- **THEN** the "Skip this version" item is hidden or disabled

#### Scenario: Force-check triggers an updater request

- **WHEN** the user clicks "Check for updates now"
- **THEN** the updater immediately performs a check (without waiting for the 4-hour interval) and the menu closes
