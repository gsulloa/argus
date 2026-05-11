# app-updater Specification

## Purpose
TBD - created by archiving change ship-beta-auto-update. Update Purpose after archive.
## Requirements
### Requirement: Updater plugin is installed and configured for beta only

The Rust app SHALL include `tauri-plugin-updater` v2 as a dependency and register it in the Tauri builder. The plugin's endpoint URL and Ed25519 public key MUST be sourced from the active Tauri config file at build time — only the beta config (`tauri.beta.conf.json`) populates these fields, so a build using the default config (future production) does NOT enable updater behavior.

#### Scenario: Beta build has updater enabled

- **WHEN** the app is built with `--config tauri.beta.conf.json` and launched
- **THEN** the plugin loads, finds a non-empty endpoints array, and is ready to perform checks

#### Scenario: Default-config build has updater disabled

- **WHEN** the app is built with the default `tauri.conf.json` and launched
- **THEN** the plugin either is not registered or finds no endpoints and never performs network checks

### Requirement: First update check runs 5 seconds after launch, then every 4 hours

The frontend SHALL trigger an updater check 5 seconds after the main window has finished initial render (not on `useEffect` mount), then every 4 hours via `setInterval` while the app remains open. Checks MUST be cancellable when the app quits.

#### Scenario: First check is deferred past initial paint

- **WHEN** the user launches the app
- **THEN** no network request to the updater endpoint occurs in the first 5 seconds; the request fires at approximately t+5s

#### Scenario: Periodic checks fire while app is open

- **WHEN** the app remains open for more than 4 hours
- **THEN** a second updater check fires automatically without user interaction

#### Scenario: Quit cancels pending checks

- **WHEN** the user quits while an update check is mid-flight
- **THEN** the request is aborted cleanly and no error is logged to the user-visible log

### Requirement: Updates download silently in the background

When the updater detects a new version (and that version is not currently skipped, see "Skip-this-version"), the plugin MUST download the archive in the background without any user-facing prompt or progress dialog. The download MUST NOT block the UI thread or any user interaction.

#### Scenario: Background download does not interrupt UX

- **WHEN** a user is interacting with the SQL editor and a background update download begins
- **THEN** typing, query execution, and grid scrolling continue with no visible pause or stutter

#### Scenario: Failed download retries on next periodic check

- **WHEN** a background download fails (network drop, 5xx from R2)
- **THEN** the failure is logged but no error surfaces in the UI; the next 4-hour check retries

### Requirement: Pending update applies on app quit

Once a download completes, the updater MUST hold the update in a pending state and apply it only when the user quits the app (by ⌘Q, closing the last window, or restart). The transition MUST be: quit → apply update → next launch starts on the new version. No mid-session swap of the running binary is allowed.

#### Scenario: Quit applies pending update

- **WHEN** an update has finished downloading and the user quits the app
- **THEN** the new version replaces the old binary on disk before the process exits, and the next launch runs the new version

#### Scenario: No pending update means normal quit

- **WHEN** the user quits with no update pending
- **THEN** the app exits normally with no extra delay or apply step

### Requirement: Skip-this-version persists across launches

The user SHALL be able to skip a specific version from a menu (in "About Argus Beta" or the version-display dropdown). When a version is skipped, the updater MUST persist the skipped version string to local app data and ignore that exact version on all subsequent checks. Newer versions MUST resume normal update behavior. The user MUST be able to clear the skip from the same menu.

#### Scenario: Skipping a version stops it from being applied

- **WHEN** the app reports v0.1.7 is available and the user clicks "Skip this version"
- **THEN** the pending download is discarded (or never started), `skipped_version: "0.1.7"` is persisted to local app data, and no further attempt is made to update to 0.1.7

#### Scenario: Newer version after skip resumes update

- **WHEN** v0.1.7 is skipped and v0.1.8 is later published
- **THEN** the next periodic check detects v0.1.8, finds it does not equal the skipped version, and proceeds to download it normally

#### Scenario: Clearing skip from the menu re-enables the version

- **WHEN** v0.1.7 is currently skipped and the user clicks "Clear skip" in the version dropdown
- **THEN** the persisted `skipped_version` is removed and the next check downloads v0.1.7 if it is still the latest

### Requirement: Manifest signature is verified before applying

The plugin MUST verify the Ed25519 signature included in `latest.json` against the downloaded archive using the public key embedded in the app at build time. An update with a missing or invalid signature MUST be rejected and logged; the app MUST NOT apply unsigned or tampered updates.

#### Scenario: Valid signature applies

- **WHEN** the manifest signature validates against the archive bytes using the embedded public key
- **THEN** the update is staged for apply on next quit

#### Scenario: Invalid signature rejected

- **WHEN** the manifest signature does not match the archive (e.g. archive was modified post-signing)
- **THEN** the update is discarded, an error is logged, and the app continues running the current version

### Requirement: Update errors do not crash or block the app

Any failure in the updater pipeline (network error, signature failure, disk full, manifest parse error) MUST be caught and logged via `tracing` to the on-disk log file. None of these errors MUST surface as a blocking dialog or interrupt the user's session. The app continues running its current version.

#### Scenario: Network failure during check is silent

- **WHEN** the updater endpoint returns a 500 or times out
- **THEN** the user sees no error, the failure is logged, and the next periodic check retries

#### Scenario: Manifest parse error is logged

- **WHEN** the fetched `latest.json` is malformed
- **THEN** an error is recorded in the log, no update is attempted, and the app continues normally

