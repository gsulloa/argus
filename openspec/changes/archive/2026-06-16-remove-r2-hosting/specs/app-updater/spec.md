## MODIFIED Requirements

### Requirement: Updates download silently in the background

When the updater detects a new version (and that version is not currently skipped, see "Skip-this-version"), the plugin MUST download the archive in the background without any user-facing prompt or progress dialog. The download MUST NOT block the UI thread or any user interaction.

#### Scenario: Background download does not interrupt UX

- **WHEN** a user is interacting with the SQL editor and a background update download begins
- **THEN** typing, query execution, and grid scrolling continue with no visible pause or stutter

#### Scenario: Failed download retries on next periodic check

- **WHEN** a background download fails (network drop, 5xx from the updater endpoint)
- **THEN** the failure is logged but no error surfaces in the UI; the next 4-hour check retries
