## MODIFIED Requirements

### Requirement: A "What's new" prompt appears after an update

The changelog host — the component that registers the command-palette entry, resolves the running version, persists the last-seen version, and drives the after-update prompt — SHALL be mounted in the connections (manager) window, the surface shown on application launch, and MUST NOT be mounted in the workspace window. The application SHALL persist the last changelog version seen by the user. On launch, after the running version resolves: if no last-seen version is stored, the app MUST silently seed it to the current version without opening the viewer; if the stored last-seen version is older than the current version, the app MUST automatically open the viewer highlighting the versions newer than the last-seen version, then update the stored last-seen version to the current version. Opening the viewer manually from the palette MUST NOT change the stored last-seen version. Auto-open MUST be suppressed when the app version is unavailable (non-Tauri runtime).

#### Scenario: Existing users are not nagged on first rollout

- **WHEN** the app launches for the first time after this feature ships and no last-seen version is stored
- **THEN** the last-seen version is silently set to the current version and the viewer does not auto-open

#### Scenario: Viewer auto-opens after an update in the connections window

- **WHEN** the app launches with a stored last-seen version older than the current version
- **THEN** the changelog viewer auto-opens in the connections (manager) window highlighting the changes since the last-seen version, and the last-seen version is updated to the current version

#### Scenario: Manual open does not affect the prompt state

- **WHEN** the user opens the changelog from the palette
- **THEN** the stored last-seen version is unchanged

#### Scenario: The workspace window does not host the changelog

- **WHEN** the workspace window is open
- **THEN** it neither auto-opens the changelog nor mounts the changelog host; the "What's new" prompt is driven only by the connections window

### Requirement: The changelog is reachable from the command palette

The command palette SHALL expose an entry that opens the changelog viewer, registered by the changelog host in the connections (manager) window. The entry MUST be grouped under "Help", labelled to reflect showing the changelog / "what's new", and MUST be discoverable via keywords including `changelog`, `release`, `notes`, `what's new`, and `version`.

#### Scenario: User opens the changelog from the palette

- **WHEN** the user invokes the "Help: Show changelog" command from the command palette in the connections window
- **THEN** the changelog viewer opens
