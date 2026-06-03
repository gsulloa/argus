## ADDED Requirements

### Requirement: Context folder layout

A context folder SHALL be a directory on the user's filesystem with the following layout, where each engine subtree is independent and may be present or absent:

```
<root>/
├── context.yaml                # required manifest
├── README.md                   # optional free-form prose
├── postgres/
│   ├── <schema>/<table>.md     # one Markdown file per documented relation
│   └── queries/<name>.sql + <name>.meta.yaml
├── mysql/         (same layout as postgres/)
├── mssql/         (same layout as postgres/)
├── dynamo/
│   ├── tables/<name>.md
│   └── queries/<name>.partiql + <name>.meta.yaml
├── cloudwatch/
│   ├── groups/<name>.md
│   └── queries/<name>.cwlogs + <name>.meta.yaml
└── ai/
    ├── overview.md             # optional
    └── glossary.md             # optional
```

A connection of a given `kind` SHALL only consume files under the matching engine subtree (`postgres/` for Postgres, etc.). Files outside any recognised subtree (other than the root manifest, `README.md`, and `ai/`) SHALL be ignored without error.

#### Scenario: Postgres connection ignores Dynamo subtree

- **WHEN** a Postgres connection is linked to a folder containing both `postgres/public/users.md` and `dynamo/tables/sessions.md`
- **THEN** the connection's documented objects list contains `public.users` and does not contain `sessions`

#### Scenario: Unrecognised top-level files are ignored

- **WHEN** a folder contains `context.yaml`, `postgres/public/users.md`, and `notes-from-meeting.txt` at the root
- **THEN** the folder is parsed successfully and `notes-from-meeting.txt` does not appear in any listing or cause a warning

#### Scenario: Missing engine subtree is not an error

- **WHEN** a Dynamo connection is linked to a folder that contains `context.yaml` and `postgres/` only
- **THEN** the connection loads successfully with an empty documented-objects list and an empty queries list

### Requirement: Root manifest

Each context folder MUST contain a `context.yaml` at its root with at minimum `schema_version: 1` and a human-readable `name`. The loader MUST reject a folder whose `context.yaml` is missing, unparseable, or declares a `schema_version` whose major component is unknown to this Argus build, and MUST surface a structured error identifying the file.

#### Scenario: Folder without context.yaml is rejected

- **WHEN** the user links a folder that does not contain a `context.yaml`
- **THEN** the link command returns an error `MissingManifest` with the folder path
- **AND** no connection state is mutated

#### Scenario: Unknown schema_version is rejected

- **WHEN** a folder's `context.yaml` declares `schema_version: 99`
- **THEN** the load returns an error `UnsupportedManifestVersion { found: 99, supported: [1] }`

#### Scenario: Manifest with name and schema_version 1 loads

- **WHEN** `context.yaml` contains `schema_version: 1` and `name: "Billing service"`
- **THEN** the folder loads and the manifest's `name` is exposed to the UI

### Requirement: Object document format

A documented object SHALL be a Markdown file whose YAML frontmatter contains exactly two top-level keys: `system:` and `human:`. The `system:` block is owned by Argus and SHALL contain at least `kind`, `name`, `last_synced`, and (for relational kinds) `schema`, `primary_key`, and `columns`. The `human:` block is owned by the user and Argus SHALL NOT write to it under any circumstance. The Markdown body below the frontmatter is owned by the user and Argus SHALL NOT write to it under any circumstance.

#### Scenario: Parser exposes both blocks separately

- **WHEN** an object file has frontmatter with `system: { kind: table, schema: public, name: users, ... }` and `human: { tags: [pii], column_notes: { email: "lowercase first" } }`
- **THEN** the parsed object exposes `system.columns` and `human.column_notes.email` as independent fields

#### Scenario: Frontmatter without system block is invalid

- **WHEN** a file has a `human:` block but no `system:` block
- **THEN** the parser surfaces a validation error identifying the file and the missing block
- **AND** the file is excluded from the documented-objects list

#### Scenario: Body is preserved byte-for-byte through any Argus operation

- **WHEN** an object file's body contains `# users\n\nThe user table.\n` and Argus performs any operation other than the user explicitly editing the file from outside
- **THEN** the body bytes are unchanged on disk

### Requirement: Query document format

A prefab query SHALL be a pair of sibling files in a `queries/` directory: a body file `<name>.<ext>` where `<ext>` is engine-appropriate (`sql` for Postgres/MySQL/MSSQL, `partiql` for Dynamo, `cwlogs` for CloudWatch Logs Insights) and a metadata file `<name>.meta.yaml`. A body file without its sibling meta file SHALL be loaded with default metadata `{ name: "<basename>", description: null, params: [], tags: [] }`. A meta file without a body sibling SHALL be reported as a validation warning and excluded from the queries list.

#### Scenario: SQL query with meta file

- **WHEN** `queries/top-customers.sql` and `queries/top-customers.meta.yaml` both exist
- **THEN** the parsed query exposes `name`, `description`, `params`, `tags` from the meta file and `body` from the SQL file

#### Scenario: SQL query without meta file

- **WHEN** `queries/raw.sql` exists but `queries/raw.meta.yaml` does not
- **THEN** the query loads with `name: "raw"`, `description: null`, `params: []`, `tags: []` and its body

#### Scenario: Orphan meta file is reported as warning

- **WHEN** `queries/ghost.meta.yaml` exists but no body file with basename `ghost` is present
- **THEN** the queries list excludes `ghost` and the load report contains a warning citing the meta file path

### Requirement: Path on connection

The `connections` row SHALL gain a nullable `context_path` field storing the user-chosen absolute path to a context folder. The path is stored verbatim as supplied by the user. The platform SHALL compute a canonical form (resolve symlinks, normalise separators, strip trailing slash) at read time for the purpose of registry keying and equality comparison, without rewriting the stored value.

#### Scenario: Stored path is preserved verbatim

- **WHEN** the user links a connection to `/Users/me/code/billing-service/argus-context/`
- **THEN** the stored `context_path` equals `/Users/me/code/billing-service/argus-context/` (trailing slash preserved)

#### Scenario: Two connections with equivalent paths share a registry entry

- **WHEN** connection A is linked to `/Users/me/billing/ctx` and connection B is linked to `/Users/me/billing/ctx/` (trailing slash)
- **THEN** both connections are recorded as subscribers of the same registry entry

### Requirement: Context registry

The backend SHALL maintain a process-lifetime registry of loaded context folders, keyed by canonical path. Each entry holds the parsed context, a filesystem watcher, and the set of subscribing connection ids. Linking a connection to a path that is already loaded SHALL add the connection to the existing entry's subscribers. Unlinking the last subscriber SHALL drop the entry and stop its watcher.

#### Scenario: Single watcher for shared folder

- **WHEN** three connections are linked to the same canonical path
- **THEN** exactly one `notify` watcher is active for that path

#### Scenario: Last unsubscribe stops the watcher

- **WHEN** three connections are linked to the same folder, and the user unlinks two
- **THEN** the watcher remains active
- **AND** when the user unlinks the third, the watcher is stopped and the entry is removed

### Requirement: Filesystem change events

When the watcher reports filesystem events for a loaded folder, the registry SHALL debounce them (200 ms for isolated edits, 500 ms when more than five events arrive within the window), re-parse only the affected files, and emit a single Tauri event `context://changed` with payload `{ path, kinds }` where `kinds` is a subset of `["manifest", "object", "query"]` indicating which categories were affected.

#### Scenario: Single edit emits one event

- **WHEN** the user saves `postgres/public/users.md` once
- **THEN** within 250 ms a single `context://changed` event is emitted with the folder's path and `kinds: ["object"]`

#### Scenario: Bulk change collapses to one event

- **WHEN** a `git checkout` rewrites 20 files in the folder
- **THEN** within 700 ms a single `context://changed` event is emitted whose `kinds` reflects every affected category

#### Scenario: Subscribers receive one event regardless of count

- **WHEN** three connections subscribe to the same folder and a file changes
- **THEN** exactly one `context://changed` event is emitted (the frontend dispatches it to each subscribing connection's UI)

### Requirement: Folder becomes unavailable

If the folder root is deleted or becomes inaccessible at runtime, the registry SHALL transition the entry to an `Unavailable` state, emit `context://changed` with `kinds: ["manifest"]`, and expose the unavailability to subscribing connections. The folder SHALL NOT be removed from any connection's `context_path`; the user resolves by restoring the folder or unlinking.

#### Scenario: Folder deleted at runtime

- **WHEN** a folder is loaded and the user (outside Argus) deletes its root directory
- **THEN** the registry transitions the entry to `Unavailable` and emits `context://changed` with `kinds: ["manifest"]`
- **AND** the connection's `context_path` is unchanged

#### Scenario: Folder never existed

- **WHEN** the application starts and a connection's `context_path` points to a directory that does not exist
- **THEN** the entry loads in `Unavailable` state and no watcher is created

### Requirement: Create-folder command

The backend SHALL expose a Tauri command `context_create_folder({ path, name })` that creates the given directory (failing if it already exists and is non-empty), writes a minimal `context.yaml` with `schema_version: 1` and the supplied `name`, writes a `README.md` placeholder, and writes a `.gitignore` containing `**/_generated.*` and `**/.argus-cache/`. The command returns the canonical path on success.

#### Scenario: Create succeeds on empty directory

- **WHEN** the user invokes `context_create_folder` with a path that does not exist
- **THEN** the directory is created with `context.yaml`, `README.md`, and `.gitignore` and the command returns the canonical path

#### Scenario: Create fails on non-empty existing directory

- **WHEN** the user invokes `context_create_folder` with a path that already contains files
- **THEN** the command returns an error `DirectoryNotEmpty` and no files are written

### Requirement: Link- and unlink-folder commands

The backend SHALL expose `context_link_folder({ connection_id, path })` which validates the folder (manifest present, parseable, supported version), records `context_path` on the connection, subscribes the connection to the registry entry, and returns the parsed manifest summary. The backend SHALL expose `context_unlink({ connection_id })` which clears `context_path` and removes the connection from the registry entry's subscribers.

#### Scenario: Linking validates the folder

- **WHEN** the user links a connection to a folder whose `context.yaml` is unparseable
- **THEN** the link command returns an error
- **AND** the connection's `context_path` is unchanged

#### Scenario: Unlinking removes subscription but preserves files

- **WHEN** the user invokes `context_unlink` for a connection
- **THEN** `context_path` is cleared on that connection and the folder on disk is not modified

### Requirement: Schema-sync command

The backend SHALL expose `context_sync_schema({ connection_id })` that walks the live schema via the connection's engine introspection, then for each found object writes or updates the matching file:

- If the file does not exist: create it with `system:` populated, empty `human:`, and body `# <object-name>\n`.
- If the file exists: parse, replace the `system:` block entirely, and write the file back with the original `human:` block and body byte-for-byte intact.

For each previously-documented file whose object is not found in the live schema, the command SHALL set `system.deleted_in_db: true` on that file and leave the rest untouched. The command SHALL return a `SyncReport` with `{ created, updated, marked_deleted, orphaned_notes }` where `orphaned_notes` lists `(file, key)` for every `human.column_notes` key that does not match a current column name. The command SHALL NOT run automatically; it is invoked only from explicit user action.

#### Scenario: New table in DB creates a new file

- **WHEN** the live schema contains `public.invoices` and the folder has no file at `postgres/public/invoices.md`
- **THEN** the sync creates the file with `system.kind: table`, `system.schema: public`, `system.name: invoices`, an empty `human:` block, and body `# invoices\n`
- **AND** the report's `created` list contains `postgres/public/invoices.md`

#### Scenario: Existing file preserves human block and body

- **WHEN** `postgres/public/users.md` exists with `human: { tags: [pii] }` and body `# users\n\nThe user table.\n`
- **AND** a new column `phone` is added to the live `users` table
- **AND** the user invokes sync
- **THEN** `system.columns` in the file now includes `phone`
- **AND** `human: { tags: [pii] }` is unchanged byte-for-byte
- **AND** the body is unchanged byte-for-byte

#### Scenario: Removed table is marked, not deleted

- **WHEN** `postgres/public/old_audit.md` exists but `public.old_audit` no longer exists in the live schema
- **AND** the user invokes sync
- **THEN** `system.deleted_in_db` is set to `true` in the file
- **AND** the file is not deleted from disk
- **AND** the report's `marked_deleted` list contains `postgres/public/old_audit.md`

#### Scenario: Renamed column produces an orphaned-note warning

- **WHEN** `postgres/public/users.md` has `human.column_notes: { old_email_col: "deprecated" }` and the live schema's `users` table has no column named `old_email_col`
- **AND** the user invokes sync
- **THEN** the report's `orphaned_notes` list contains `{ file: "postgres/public/users.md", key: "old_email_col" }`
- **AND** the file's `human.column_notes` is unchanged

#### Scenario: Atomic per-file writes

- **WHEN** sync writes to `postgres/public/users.md`
- **THEN** the write goes through a temp file plus rename so a concurrent reader sees either the old or new full file, never a truncated one

### Requirement: AI payload command

The backend SHALL expose `context_ai_payload({ connection_id, include_full_bodies })` that returns the linked folder's contents as a structured JSON payload `{ manifest, overview, glossary, objects: [{ name, system, human, body_summary | body }], queries: [{ name, description, body }] }`. When `include_full_bodies` is `false` (default), each object includes `body_summary` (the first paragraph of its Markdown body). When `true`, each object includes the full `body`. The command SHALL return an empty payload (all arrays empty, `manifest: null`) if the connection has no linked folder.

#### Scenario: Default payload uses body summaries

- **WHEN** an object's body is `# users\n\nThe user table.\n\n## Gotchas\n- email is case-insensitive.\n`
- **AND** the user invokes `context_ai_payload` with `include_full_bodies: false`
- **THEN** the object entry has `body_summary: "The user table."` and no `body` field

#### Scenario: Full bodies opt-in

- **WHEN** the user invokes `context_ai_payload` with `include_full_bodies: true`
- **THEN** each object entry has its full Markdown body and no `body_summary` field

#### Scenario: Connection without folder returns empty payload

- **WHEN** a connection has `context_path: null`
- **AND** the user invokes `context_ai_payload`
- **THEN** the command returns `{ manifest: null, overview: null, glossary: null, objects: [], queries: [] }`
