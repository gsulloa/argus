## ADDED Requirements

### Requirement: Project source path in context.yaml

A context folder's `context.yaml` MAY carry an optional `project_source_path` — an absolute path to the application source repository that the AI model inspector reads. It SHALL be stored in the manifest's forward-compatible extra fields (alongside `schema_version` and `name`), requiring no schema-version change and no database migration. The system SHALL expose commands to read and write it for a connection's linked folder. Writing it SHALL preserve `schema_version`, `name`, and any other existing extra fields. A context folder that omits `project_source_path` is valid and behaves exactly as before.

#### Scenario: Setting and reading the project source path

- **WHEN** the user sets the project source path for a connection's linked folder to `/Users/me/app`
- **THEN** reading it back returns `/Users/me/app`, and `context.yaml` retains its `schema_version`, `name`, and any other extra fields unchanged

#### Scenario: Folder without a project source path is unaffected

- **WHEN** a context folder's `context.yaml` has no `project_source_path`
- **THEN** reading the project source path returns no value (not an error) and all existing context-folder behaviour is unchanged
