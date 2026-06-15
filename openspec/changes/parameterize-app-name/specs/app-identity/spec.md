## ADDED Requirements

### Requirement: Single source of truth for display name

The system SHALL define the application's human-facing display name in exactly one location per runtime layer (one Rust constant, one frontend constant), and all display-safe usages SHALL reference that constant rather than a hardcoded literal.

#### Scenario: Rust code references the display name

- **WHEN** Rust code needs the app's display name (window title, log copy, error messages, about text)
- **THEN** it reads it from the central app-identity module
- **AND** no `safe`-classified `"Argus"` string literal remains elsewhere in `src-tauri/src/`

#### Scenario: Frontend code references the display name

- **WHEN** frontend code or markup needs the app's display name (`<title>`, headers, about dialog)
- **THEN** it reads it from a single shared frontend constant
- **AND** the only hardcoded display literal lives in that constant (or is injected at build time from it)

#### Scenario: Changing the display name in one place

- **WHEN** a developer changes the display name in the central constant(s)
- **THEN** every display-safe surface (window title, page title, UI copy) reflects the new name after rebuild
- **AND** no migration-sensitive identifier is altered as a side effect

### Requirement: Classification of brand identifiers

The system SHALL classify every occurrence of the app name as either `display-safe` (changeable freely) or `migration-sensitive` (changing it breaks already-installed instances), and migration-sensitive identifiers SHALL be grouped in a clearly labeled location distinct from display strings.

#### Scenario: Migration-sensitive identifiers are isolated and labeled

- **WHEN** a developer inspects the app-identity layer
- **THEN** the bundle identifier, keychain service name, database filename, log filename, Cargo package/lib names, MCP sidecar command, and AI env-var prefix are each present, named, and annotated as migration-sensitive
- **AND** each annotation states what breaks if it changes (e.g. "stored API keys become unreachable")

#### Scenario: Display string change does not touch migration-sensitive values

- **WHEN** only the display name constant is changed
- **THEN** the keychain service, database filename, log filename, and bundle identifier retain their original values
- **AND** an existing installation's stored credentials, database, and logs remain accessible

### Requirement: Documented renaming procedure

The system SHALL include documentation describing the complete procedure for renaming the application, covering both display-safe and migration-sensitive identifiers, including the data-migration implications of changing migration-sensitive values.

#### Scenario: Developer follows the rename procedure

- **WHEN** a developer wants to rename the app for a public release
- **THEN** the documentation lists every file and identifier to change, grouped by classification
- **AND** for each migration-sensitive identifier it states the user-data consequence and any migration step required (e.g. re-keying the keychain, renaming or migrating the existing database file)
