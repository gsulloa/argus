# connection-context-folders Specification

## Purpose
TBD - created by archiving change context-folders-other-engines. Update Purpose after archive.
## Requirements
### Requirement: Schema sync supports MySQL, MSSQL, and Dynamo

The `context_sync_schema` command SHALL produce a valid `SyncReport` for connections of kind `mysql`, `mssql`, `dynamo`, and `athena` in addition to `postgres`. The command introspects the live source via the engine's existing pool/client registry and writes `ObjectShape`-derived `system:` blocks to the linked context folder using the same atomic, body-preserving rules already specified for Postgres. For Dynamo connections, the target file path SHALL be `dynamo/tables/<logical>/table.md`, where `<logical>` is the **logical** (normalized) table name — the live table name folded through the connection's table-name normalization rule (see `dynamo-table-name-normalization`) — so each table is a self-contained folder holding its `table.md` doc alongside its `models/` subdirectory, and re-deploys that change the random suffix update the same `dynamo/tables/<logical>/table.md` file instead of creating a new one. When no rule is configured the logical name equals the live name, preserving prior behavior. If a pre-existing legacy flat `dynamo/tables/<logical>.md` file is present when a sync runs, the command SHALL relocate it to `dynamo/tables/<logical>/table.md` (moving the bytes so the `human:` block and body are preserved) before applying the `system:` splice, upgrading old folders in place. Sync SHALL be **convergent under the normalization rule**: content laid down before a rule was configured (or under a different rule) folds into the logical folder rather than being duplicated or stranded. Concretely: (a) when matching an existing table doc to a live shape, the doc's `system.name` SHALL be folded through the normalization rule before deriving its canonical path, so a doc whose frontmatter still carries the physical (suffixed) name is updated in place under the logical folder — and its `system.name` rewritten to the logical name — instead of being marked deleted while a parallel logical folder is created; (b) before writing, sync SHALL consolidate any sibling entry whose name normalizes to the same logical name — a directory `dynamo/tables/<physical>/` is merged into `dynamo/tables/<logical>/` (its `table.md` moved if the logical folder has none, its `models/*.md` moved into the logical folder's `models/`, skipping any name collisions, and the physical directory removed when emptied), and a legacy flat `dynamo/tables/<physical>.md` is migrated to `dynamo/tables/<logical>/table.md` when that target does not yet exist. Consolidation MUST only act on an entry when its folded name is one of the **live logical names of the current sync** — normalization rules are not necessarily idempotent, and an over-broad rule must not relocate user-curated folders into a destination that corresponds to no live table. When two or more distinct live tables normalize to the same logical name within one sync, the **first SHALL win and the rest SHALL be skipped**, and each skipped collision SHALL be surfaced in the `SyncReport` (e.g. via its warnings/skipped channel) rather than aborting the sync. For Athena the introspection source is AWS Glue (databases → schemas, tables/views → relations, Glue column types → columns), and the engine is organised like the other SQL engines: object files live at `athena/<database>/<relation>.md`.

#### Scenario: MySQL connection produces a sync report

- **WHEN** the user invokes `context_sync_schema` on a connected MySQL connection whose linked folder is empty
- **THEN** the command returns a `SyncReport` whose `created` list contains one path per non-system relation, each path of the form `mysql/<schema>/<relation>.md`
- **AND** each created file's `system.kind` is `"table"` or `"view"` and `system.schema` matches the source schema

#### Scenario: MSSQL connection produces a sync report

- **WHEN** the user invokes `context_sync_schema` on a connected MSSQL connection whose linked folder is empty
- **THEN** the command returns a `SyncReport` whose `created` list contains one path per non-system relation, each path of the form `mssql/<schema>/<relation>.md`
- **AND** each created file's `system.kind` is `"table"` or `"view"`

#### Scenario: Dynamo connection produces a sync report

- **WHEN** the user invokes `context_sync_schema` on a connected Dynamo connection (with no normalization rule) whose linked folder is empty
- **THEN** the command returns a `SyncReport` whose `created` list contains one path per table, each path of the form `dynamo/tables/<table>/table.md`
- **AND** each created file's `system.kind` is `"dynamo_table"`, `system.schema` is omitted, `system.primary_key` lists the partition key followed by the sort key (if any), and `system.columns` contains only entries derived from `AttributeDefinition` (typed key + indexed attributes)

#### Scenario: Dynamo sync writes the logical filename under a normalization rule

- **WHEN** a Dynamo connection's rule strips `prefix: "MyApp-prod-"` and `suffix_pattern: "-[A-Z0-9]+$"`, and the live account has a table `MyApp-prod-EventsTable-3M4N5O6P7Q8R`
- **THEN** the `SyncReport` references the path `dynamo/tables/EventsTable/table.md` (the logical name), not the suffixed live name

#### Scenario: Re-deploy with a new suffix updates the same file

- **WHEN** a folder already contains `dynamo/tables/EventsTable/table.md` from a prior sync, the rule strips the prefix and random suffix, and the connection re-syncs after a deploy that renamed the live table to `MyApp-prod-EventsTable-9Z8Y7X6W5V4U`
- **THEN** `dynamo/tables/EventsTable/table.md` is updated in place (its `human:` block and body preserved) and no new suffixed file or folder is created

#### Scenario: Legacy flat table doc is migrated into the folder on sync

- **WHEN** a folder contains a legacy flat `dynamo/tables/Events.md` (with a hand-written `human:` block and body) from a sync produced before this change, and the connection re-syncs
- **THEN** the file is relocated to `dynamo/tables/Events/table.md` with its `human:` block and body preserved, the new `system:` block is spliced in, the flat `dynamo/tables/Events.md` no longer exists, and any pre-existing `dynamo/tables/Events/models/` docs are left untouched

#### Scenario: Configuring a rule after the fact folds the physical folder into the logical one

- **WHEN** a folder contains `dynamo/tables/MyApp-prod-EventsTable-3M4N/table.md` (with a hand-edited `human:` block whose `system.name` is the physical name) and `dynamo/tables/MyApp-prod-EventsTable-3M4N/models/Order.md`, both written before any rule existed, and the user then configures a rule that folds the physical name to `EventsTable` and re-syncs
- **THEN** after the sync there is a single folder `dynamo/tables/EventsTable/` containing `table.md` (the `human:` block and body preserved, `system.name` rewritten to `EventsTable`) and `models/Order.md`, the physical-named folder no longer exists, and the `SyncReport` records the table as updated — not as deleted plus created

#### Scenario: Stranded physical models folder is merged into the logical folder

- **WHEN** a folder contains models at `dynamo/tables/MyApp-prod-EventsTable-3M4N/models/Order.md` (written before any rule existed, no `table.md` beside them) and a prior rule-aware sync already created `dynamo/tables/EventsTable/table.md`, and the connection re-syncs with the rule active
- **THEN** `Order.md` is moved to `dynamo/tables/EventsTable/models/Order.md`, the physical-named folder is removed, and `dynamo/tables/EventsTable/table.md` is updated in place

#### Scenario: Over-stripping rule does not relocate folders with no live counterpart

- **WHEN** the rule `suffix_pattern: "-[0-9A-Za-z]+$"` folds the hand-curated folder name `CacheStack-CacheTable` to `CacheStack`, and no live table normalizes to `CacheStack` in the current sync
- **THEN** the consolidation pass leaves `dynamo/tables/CacheStack-CacheTable/` untouched and creates no `dynamo/tables/CacheStack/` folder, while entries that do fold to a live logical name (e.g. the suffixed physical folder holding stranded models) are still consolidated normally

#### Scenario: Existing doc carrying the physical name is not marked deleted under a rule

- **WHEN** an existing `table.md` parses with a `system.name` equal to the live physical name, the rule folds that name to a logical name present in the live account, and the connection syncs
- **THEN** the doc is matched to the live table via the folded name and updated in place; it is not marked `deleted_in_db` and no parallel logical folder is created

#### Scenario: Colliding live tables are skipped with a warning

- **WHEN** an over-broad rule normalizes two distinct live tables `MyApp-prod-Events-AAAA` and `MyApp-prod-Events-BBBB` both to the logical name `Events` within one sync
- **THEN** the first is written to `dynamo/tables/Events/table.md`, the second is skipped, and the `SyncReport` surfaces the skipped collision; the sync does not abort

#### Scenario: Athena connection produces a sync report

- **WHEN** the user invokes `context_sync_schema` on a connected Athena connection whose linked folder is empty
- **THEN** the command returns a `SyncReport` whose `created` list contains one path per Glue relation, each path of the form `athena/<database>/<relation>.md`
- **AND** each created file's `system.kind` is `"table"` or `"view"` (view when the Glue `TableType` is `VIRTUAL_VIEW`), `system.schema` matches the Glue database, `system.primary_key` is empty, and `system.columns` contains the storage-descriptor columns followed by partition keys

### Requirement: Existing files preserve human and body across all engines

When `context_sync_schema` re-runs on a folder where object files already exist with hand-edited `human:` blocks and Markdown bodies, every existing file's `human:` block and body SHALL be preserved byte-for-byte. When the file's `system:` block differs from the live schema the `system:` block SHALL be replaced to reflect the current source schema; when it does not differ the file SHALL NOT be rewritten at all (see "Schema sync is diff-aware and idempotent").

If an existing file cannot be parsed, the command SHALL retry once after normalizing CRLF line endings to LF in memory. If it parses on retry the command SHALL proceed normally (preserving the historical CRLF→LF repair behavior). If it still cannot be parsed the command SHALL log a warning and skip the file — it SHALL NEVER overwrite or recreate an unparseable file, so a corrupt `system:` block can never destroy a user's hand-written content.

#### Scenario: Existing files preserve human and body across all engines

- **WHEN** a MySQL/MSSQL/Dynamo/Athena connection re-runs `context_sync_schema` on a folder where some object files already exist with hand-edited `human:` blocks and Markdown bodies
- **THEN** every existing file's `human:` block and body are preserved byte-for-byte
- **AND** the `system:` block is replaced to reflect the current source schema only when it differs, and the file is left untouched when it matches

#### Scenario: CRLF file is repaired on re-parse

- **WHEN** an existing object file uses CRLF line endings (causing the initial parse to fail) and its table is still present in the live schema
- **THEN** the command re-parses it after normalizing line endings, and if the schema differs writes it back with LF line endings, or leaves it untouched if the schema matches

#### Scenario: Corrupt file is skipped, never overwritten

- **WHEN** an existing object file has a `system:` block that cannot be parsed even after CRLF normalization
- **THEN** the command logs a warning, does not overwrite or recreate the file, and the user's content is left intact

### Requirement: Introspector pools bundle

The internal `introspector_for(engine, pools)` dispatcher SHALL accept an `IntrospectorPools` struct containing references to all wired engine registries (`PgPoolRegistry`, `MysqlPoolRegistry`, `MssqlPoolRegistry`, `DynamoClientRegistry`, `AthenaClientRegistry`, `CloudwatchClientRegistry`). The `context_sync_schema` Tauri command SHALL receive each registry as a `State<>` parameter, assemble the bundle, and pass it to the dispatcher. All engines with a connection kind (`postgres`, `mysql`, `mssql`, `dynamo`, `athena`, `cloudwatch`) dispatch to a real introspector; `NotImplementedIntrospector` remains only as the fall-through for an unrecognised engine.

#### Scenario: Athena dispatches to its introspector

- **WHEN** `context_sync_schema` is invoked on a connection whose `kind` is `athena`
- **THEN** the dispatcher routes to `AthenaIntrospector` using the `AthenaClientRegistry` from the bundle

#### Scenario: CloudWatch dispatches to its introspector

- **WHEN** `context_sync_schema` is invoked on a connection whose `kind` is `cloudwatch`
- **THEN** the dispatcher routes to `CloudwatchIntrospector` using the `CloudwatchClientRegistry` from the bundle

#### Scenario: Postgres path is unchanged

- **WHEN** `context_sync_schema` is invoked on a Postgres connection
- **THEN** the command returns the same `SyncReport` shape and behaviour as before this change

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

### Requirement: Project source path in context.yaml

A context folder's `context.yaml` MAY carry an optional `project_source_path` — an absolute path to the application source repository that the AI model inspector reads. It SHALL be stored in the manifest's forward-compatible extra fields (alongside `schema_version` and `name`), requiring no schema-version change and no database migration. The system SHALL expose commands to read and write it for a connection's linked folder. Writing it SHALL preserve `schema_version`, `name`, and any other existing extra fields. A context folder that omits `project_source_path` is valid and behaves exactly as before.

#### Scenario: Setting and reading the project source path

- **WHEN** the user sets the project source path for a connection's linked folder to `/Users/me/app`
- **THEN** reading it back returns `/Users/me/app`, and `context.yaml` retains its `schema_version`, `name`, and any other extra fields unchanged

#### Scenario: Folder without a project source path is unaffected

- **WHEN** a context folder's `context.yaml` has no `project_source_path`
- **THEN** reading the project source path returns no value (not an error) and all existing context-folder behaviour is unchanged

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

### Requirement: Schema sync supports CloudWatch log groups

The `context_sync_schema` command SHALL produce a valid `SyncReport` for connections of kind `cloudwatch`. The introspection source is the CloudWatch Logs API (`DescribeLogGroups`, paged); each log group becomes an `ObjectShape { kind: "log_group", schema: None, name: <log group name>, primary_key: [], columns: [] }`. Object docs are written under `cloudwatch/groups/`, one file per log group, using the same atomic, body-preserving splice rules already specified for the other engines.

Because log-group names contain `/` (e.g. `/aws/lambda/checkout`), the target filename SHALL be derived by folding the group name with a **simple `/` → `__` rule** (`/aws/lambda/checkout` → `cloudwatch/groups/__aws__lambda__checkout.md`), producing a flat file with no nested directories. The fold SHALL be applied in `context/sync.rs` (`target_path_for`, write side) and **reversed** (`__` → `/`) in `context/parser.rs` when reconstructing the object name from the filename (read side), so the same group round-trips to the same file. A literal `__` inside a group name is a known, documented limitation of the simple scheme.

#### Scenario: CloudWatch connection produces a sync report

- **WHEN** the user invokes `context_sync_schema` on a connected CloudWatch connection whose linked folder is empty
- **THEN** the command returns a `SyncReport` whose `created` list contains one path per log group, each of the form `cloudwatch/groups/<folded-name>.md`
- **AND** each created file's `system.kind` is `"log_group"`, `system.schema` is omitted, and `system.primary_key` and `system.columns` are empty

#### Scenario: Slashed group name folds to a flat file

- **WHEN** the live account has a log group named `/aws/lambda/checkout`
- **THEN** the `SyncReport` references the path `cloudwatch/groups/__aws__lambda__checkout.md` (flat, no nested `aws/lambda/` directories)

#### Scenario: Folded filename round-trips on read

- **WHEN** a folder contains `cloudwatch/groups/__aws__lambda__checkout.md` and the context folder is parsed
- **THEN** the parser reconstructs the object name `/aws/lambda/checkout` so a subsequent sync of the same group updates that file in place rather than creating a new one

#### Scenario: Existing file preserves human and body on re-sync

- **WHEN** a CloudWatch connection re-runs `context_sync_schema` on a folder where a log-group file already exists with a hand-edited `human:` block and Markdown body
- **THEN** the existing file's `human:` block and body are preserved byte-for-byte and only the `system:` block is replaced

### Requirement: Schema sync is diff-aware and idempotent

The `context_sync_schema` command SHALL only write an existing object file when its on-disk `system:` block differs from the live source schema. Equality SHALL be determined by comparing the parsed `system:` block against the live `ObjectShape` on these fields only: `kind`, `schema`, `name`, `primary_key`, and `columns` as an ordered list of `{name, type}` pairs. The `last_synced` and `deleted_in_db` fields, and any per-column extra fields, SHALL be excluded from the comparison. When the comparison is equal the command SHALL NOT rewrite the file, SHALL NOT bump `last_synced`, and SHALL record the object in the report's `unchanged` count rather than its `updated` list.

A file already carrying `deleted_in_db: true` whose object remains absent from the live schema SHALL be a no-op: the command SHALL NOT rewrite it and SHALL NOT bump `last_synced`. Only the first transition of a still-present-then-removed object to `deleted_in_db: true` SHALL write.

As a consequence, running `context_sync_schema` twice in a row against a folder whose schema has not changed SHALL produce zero file writes on the second run, for connections of every supported engine (`postgres`, `mysql`, `mssql`, `dynamo`, `athena`).

#### Scenario: Re-sync with no schema change writes nothing

- **WHEN** `context_sync_schema` runs against a folder, and then runs a second time with the live schema unchanged
- **THEN** the second run rewrites no files and bumps no `last_synced` timestamp
- **AND** every existing object is reported in the `unchanged` count, with empty `created`, `updated`, and `marked_deleted` lists

#### Scenario: Adding one column modifies exactly one file

- **WHEN** a column is added to one table in a folder that already has synced docs for many tables, and the connection re-syncs
- **THEN** exactly one file is rewritten (the changed table's), every other existing file is left byte-for-byte unchanged, and the others are reported in the `unchanged` count

#### Scenario: Adding one new table creates exactly one file

- **WHEN** a new table is added to a source whose other tables already have synced docs, and the connection re-syncs
- **THEN** exactly one file is created (the new table's) and every pre-existing file is left untouched and reported as unchanged

#### Scenario: Re-marking an already-deleted table writes nothing

- **WHEN** an object file already carries `deleted_in_db: true`, its object is still absent from the live schema, and the connection re-syncs
- **THEN** the file is not rewritten, its `last_synced` is not bumped, and it is not reported in `marked_deleted`

### Requirement: Sync report carries per-object change summaries

The `SyncReport` returned by `context_sync_schema` SHALL describe each modified object, not merely list its path. The `updated` field SHALL be a list of entries, each carrying the object's file `path` and a `changes` list of human-readable strings describing what changed in the `system:` block (for example: an added column, a removed column, a column type change rendered as `old → new`, a primary-key change, or a column-order change). The report SHALL also carry an `unchanged` count of objects whose `system:` block matched the live schema. The `created` and `marked_deleted` fields remain path lists. The sync dialog SHALL render the per-object change summaries and the unchanged count rather than a flat list of all touched paths.

#### Scenario: Report describes what changed per object

- **WHEN** a sync changes a column's type and adds another column to the same table
- **THEN** that table appears once in `updated` with its path and a `changes` list naming both the type change (as `old → new`) and the added column

#### Scenario: Report counts unchanged objects without listing them

- **WHEN** a sync leaves most objects unchanged and modifies a few
- **THEN** the report's `unchanged` value equals the count of untouched objects and those objects are not enumerated in any list

### Requirement: Connection form reflects context-folder state live

The connection-config form SHALL render the `ContextFolderRow` from the **live** connection record held in the connections registry store, identified by connection id, rather than from the immutable connection snapshot captured when the form was opened. After the user links, creates-and-links, or unlinks a context folder while the form is open, the linked-path display, the "Shared with N" count, and the **Sync schema…** button SHALL appear, update, or disappear immediately — within the same open window and without requiring the user to Save the connection or close and reopen the configuration window. This applies uniformly to every engine connection form that mounts `ContextFolderRow` (Postgres, MySQL, MSSQL, DynamoDB, Athena, CloudWatch).

#### Scenario: Linking a folder shows the Sync button immediately

- **WHEN** the user opens the configuration window for a saved connection that has no context folder, and links an existing context folder via the row's picker
- **THEN** the linked path row and the **Sync schema…** button appear in the same open window immediately after the link succeeds
- **AND** the user does not need to Save the connection or reopen the window for them to appear

#### Scenario: Creating and linking a new folder updates state immediately

- **WHEN** the user creates a new context folder from the row and it is linked to the open connection
- **THEN** the row transitions from the unlinked state to the linked state in place, showing the new path and the **Sync schema…** button

#### Scenario: Unlinking a folder reverts the row immediately

- **WHEN** the user unlinks the context folder from a connection while its configuration window is open
- **THEN** the row reverts to the unlinked state (folder picker / reuse options) in the same open window, without requiring Save or reopen

#### Scenario: Live state holds across every engine form

- **WHEN** any of the Postgres, MySQL, MSSQL, DynamoDB, Athena, or CloudWatch connection forms is open in edit mode and a context folder is linked or unlinked
- **THEN** that form reflects the change immediately, sourcing `contextPath` from the live registry record rather than the form's opening snapshot

