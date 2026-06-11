## ADDED Requirements

### Requirement: Project source path is local per-connection state

The application source repository path used by the AI model inspector — `project_source_path` — SHALL be stored as local, per-connection state in the application's local database (a nullable field on the connection record), never in the shared, committable `context.yaml`. The path SHALL be readable and writable per connection independent of whether the connection has a linked context folder. A connection with no configured `project_source_path` SHALL read back no value (not an error).

The system SHALL expose a command to read the path for a connection (returning the value or no value) and a command to set it for a connection. Setting the path SHALL persist it to the connection's local record and SHALL NOT write it to any file inside the context folder.

#### Scenario: Setting and reading the source path for a connection

- **WHEN** the user sets the project source path for a connection to `/Users/me/app`
- **THEN** reading it back for that connection returns `/Users/me/app`
- **AND** the connection's linked `context.yaml` (if any) is not modified and does not gain a `project_source_path` key

#### Scenario: Connection without a source path

- **WHEN** a connection has never had a project source path set and carries no legacy value
- **THEN** reading the project source path for that connection returns no value (not an error)

#### Scenario: Reading/writing does not require a linked folder

- **WHEN** the user sets, then reads, the project source path for a connection that has no linked context folder
- **THEN** the value round-trips successfully without a "no linked folder" error

### Requirement: Legacy context.yaml source path is migrated to local storage

When the project source path is resolved for a connection whose local record has no value, the system SHALL check the connection's linked context folder (if any) for a legacy `project_source_path` in `context.yaml`. If present, the system SHALL copy that value into the connection's local record, remove the `project_source_path` key from `context.yaml` while preserving `schema_version`, `name`, and all other extra fields, and return the migrated value. This migration SHALL be performed by the same resolution path used by both the read command and the AI model inspector, so it occurs on first use regardless of entry point.

#### Scenario: First resolve migrates a committed path out of context.yaml

- **WHEN** a connection's local record has no source path, its linked `context.yaml` contains `project_source_path: /Users/me/app`, and the source path is resolved (via the read command or the inspector)
- **THEN** the resolved value is `/Users/me/app`
- **AND** the value is now stored in the connection's local record
- **AND** `context.yaml` no longer contains a `project_source_path` key while retaining its `schema_version`, `name`, and any other extra fields unchanged

#### Scenario: Local record takes precedence over context.yaml

- **WHEN** a connection's local record already holds a source path and its `context.yaml` also still contains a different legacy `project_source_path`
- **THEN** resolution returns the local-record value and does not consult or modify `context.yaml`

### Requirement: AI model inspector reads the source path from the connection record

The DynamoDB AI model inspector flow (`ai_inspect_models`) SHALL obtain the project source path by resolving it from the connection's local record (including the legacy migration above), not by reading `context.yaml` directly. If the resolved value is absent, the flow SHALL return a validation error indicating the project source path is not configured. The flow SHALL continue to require a linked context folder for table documentation independently of the source-path resolution.

#### Scenario: Inspector resolves a configured source path

- **WHEN** the inspector runs for a connection whose local record holds `project_source_path: /Users/me/app`
- **THEN** the inspector process is launched against `/Users/me/app` as its working directory

#### Scenario: Inspector errors when no source path is configured

- **WHEN** the inspector runs for a connection that has no source path in its local record and no legacy value in `context.yaml`
- **THEN** the flow returns a validation error stating the project source path is not configured
