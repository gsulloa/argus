## MODIFIED Requirements

### Requirement: Known context folders are discoverable for reuse

The platform SHALL expose a command (e.g. `context_list_known_folders`) that
returns the distinct context-folder roots already referenced by saved
connections, so the link/setup UI can offer reuse of an existing project folder
instead of always creating a new one. Each returned entry SHALL include the
canonical root path, the folder's display name read from its `context.yaml`
manifest, and the set of connections currently linked to that root. For each such
linked connection the entry SHALL include enough to identify it in the UI — at
minimum its connection id, its display name, and its engine/kind — so that folders
sharing the same manifest name remain distinguishable. Roots whose
`context_path` no longer exists on disk, or whose `context.yaml` is missing or
unparseable, SHALL be omitted from the result. Folders are identified by their
canonical path so connections pointing at the same root via different path
strings collapse into a single entry. The command SHALL NOT couple the result to
`connection-groups`: membership in a group SHALL NOT affect whether a folder is
listed.

The reuse-first selector UI, on every surface that offers known folders when
linking a connection that has no context folder (the connection-editor row, the
Dynamo model-editor link dialog, and the Context Queries tree setup CTA), SHALL
render on each option disambiguating context beyond the manifest name alone: the
canonical path (or a distinctive fragment of it) SHALL be visible, and the
connections already referencing that folder SHALL be presented by display name
and engine (not by opaque id). When two listed folders share the same manifest
name, the rendered options MUST differ in visible content so the user can pick
the correct one without opening it.

#### Scenario: Two connections share one root

- **WHEN** two connections (e.g. a Postgres and a Dynamo connection) both have `context_path` resolving to the same canonical root, and the user invokes `context_list_known_folders`
- **THEN** the result contains exactly one entry for that root
- **AND** the entry's name matches the `context.yaml` manifest name and its connection list contains both connection ids, each with its display name and engine/kind

#### Scenario: Same-named folders are distinguishable in the selector

- **WHEN** two known context folders both have the manifest name `context` but resolve to different canonical roots, and the reuse-first selector is shown while linking a connection with no context folder
- **THEN** each option displays its canonical path (or a distinctive path fragment) and the display names and engines of the connections already using it
- **AND** the two options differ in visible content so the user can identify which project each belongs to

#### Scenario: Stale path is omitted

- **WHEN** a connection's `context_path` points at a directory that no longer exists on disk, and the user invokes `context_list_known_folders`
- **THEN** that root is not included in the result

#### Scenario: No linked folders

- **WHEN** no saved connection has a `context_path`, and the user invokes `context_list_known_folders`
- **THEN** the command returns an empty array

#### Scenario: Group membership does not affect listing

- **WHEN** two connections share one canonical root but belong to different connection groups (or no group)
- **THEN** the root is still returned as a single entry listing both connections
