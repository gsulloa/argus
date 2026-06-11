## MODIFIED Requirements

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

#### Scenario: Existing files preserve human and body across all engines

- **WHEN** a MySQL/MSSQL/Dynamo/Athena connection re-runs `context_sync_schema` on a folder where some object files already exist with hand-edited `human:` blocks and Markdown bodies
- **THEN** every existing file's `human:` block and body are preserved byte-for-byte
- **AND** the `system:` block is replaced to reflect the current source schema
