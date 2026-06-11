## ADDED Requirements

### Requirement: Creating a folder is idempotent over an existing context folder

The `context_create_folder` command SHALL succeed when the target directory does
not exist (creating it and scaffolding `context.yaml`, `README.md`, and
`.gitignore`) **or** when the target directory already exists and is a valid
context folder (contains a parseable `context.yaml`). In the latter case the
command SHALL NOT overwrite the existing `context.yaml`, `README.md`, or
`.gitignore`, SHALL leave all existing object docs and queries untouched, and
SHALL return the canonical path — making it safe to point a second or third
connection of a project at the same root. The command SHALL continue to return a
validation error when the target directory exists, is non-empty, and is **not** a
valid context folder (no parseable `context.yaml`).

#### Scenario: Target directory does not exist

- **WHEN** the user invokes `context_create_folder` with a `path` that does not exist
- **THEN** the directory is created with `context.yaml` (the given `name`, `schema_version: 1`), `README.md`, and `.gitignore`
- **AND** the command returns the canonical path

#### Scenario: Target is already a valid context folder

- **WHEN** the user invokes `context_create_folder` on a directory that already contains a parseable `context.yaml` (for example, scaffolded earlier by another connection in the same project)
- **THEN** the command succeeds and returns the canonical path
- **AND** the existing `context.yaml`, `README.md`, `.gitignore`, object docs, and queries are left byte-for-byte unchanged

#### Scenario: Target is a non-empty foreign directory

- **WHEN** the user invokes `context_create_folder` on a non-empty directory that does **not** contain a parseable `context.yaml`
- **THEN** the command returns a validation error and writes nothing

### Requirement: Known context folders are discoverable for reuse

The platform SHALL expose a command (e.g. `context_list_known_folders`) that
returns the distinct context-folder roots already referenced by saved
connections, so the link/setup UI can offer reuse of an existing project folder
instead of always creating a new one. Each returned entry SHALL include the
canonical root path, the folder's display name read from its `context.yaml`
manifest, and the set of connections currently linked to that root. Roots whose
`context_path` no longer exists on disk, or whose `context.yaml` is missing or
unparseable, SHALL be omitted from the result. Folders are identified by their
canonical path so connections pointing at the same root via different path
strings collapse into a single entry. The command SHALL NOT couple the result to
`connection-groups`: membership in a group SHALL NOT affect whether a folder is
listed.

#### Scenario: Two connections share one root

- **WHEN** two connections (e.g. a Postgres and a Dynamo connection) both have `context_path` resolving to the same canonical root, and the user invokes `context_list_known_folders`
- **THEN** the result contains exactly one entry for that root
- **AND** the entry's name matches the `context.yaml` manifest name and its connection list contains both connection ids

#### Scenario: Stale path is omitted

- **WHEN** a connection's `context_path` points at a directory that no longer exists on disk, and the user invokes `context_list_known_folders`
- **THEN** that root is not included in the result

#### Scenario: No linked folders

- **WHEN** no saved connection has a `context_path`, and the user invokes `context_list_known_folders`
- **THEN** the command returns an empty array

#### Scenario: Group membership does not affect listing

- **WHEN** two connections share one canonical root but belong to different connection groups (or no group)
- **THEN** the root is still returned as a single entry listing both connections
