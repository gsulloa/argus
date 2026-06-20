## ADDED Requirements

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

## MODIFIED Requirements

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
