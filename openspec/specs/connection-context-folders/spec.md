# connection-context-folders Specification

## Purpose
TBD - created by archiving change context-folders-other-engines. Update Purpose after archive.
## Requirements
### Requirement: Schema sync supports MySQL, MSSQL, and Dynamo

The `context_sync_schema` command SHALL produce a valid `SyncReport` for connections of kind `mysql`, `mssql`, `dynamo`, and `athena` in addition to `postgres`. The command introspects the live source via the engine's existing pool/client registry and writes `ObjectShape`-derived `system:` blocks to the linked context folder using the same atomic, body-preserving rules already specified for Postgres. For Dynamo connections, the target file path SHALL be derived from the **logical** (normalized) table name — the live table name folded through the connection's table-name normalization rule (see `dynamo-table-name-normalization`) — so re-deploys that change the random suffix update the same `dynamo/tables/<logical>.md` file instead of creating a new one. When no rule is configured the logical name equals the live name, preserving prior behavior. When two or more distinct live tables normalize to the same logical name within one sync, the **first SHALL win and the rest SHALL be skipped**, and each skipped collision SHALL be surfaced in the `SyncReport` (e.g. via its warnings/skipped channel) rather than aborting the sync. For Athena the introspection source is AWS Glue (databases → schemas, tables/views → relations, Glue column types → columns), and the engine is organised like the other SQL engines: object files live at `athena/<database>/<relation>.md`.

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
- **THEN** the command returns a `SyncReport` whose `created` list contains one path per table, each path of the form `dynamo/tables/<table>.md`
- **AND** each created file's `system.kind` is `"dynamo_table"`, `system.schema` is omitted, `system.primary_key` lists the partition key followed by the sort key (if any), and `system.columns` contains only entries derived from `AttributeDefinition` (typed key + indexed attributes)

#### Scenario: Dynamo sync writes the logical filename under a normalization rule

- **WHEN** a Dynamo connection's rule strips `prefix: "MyApp-prod-"` and `suffix_pattern: "-[A-Z0-9]+$"`, and the live account has a table `MyApp-prod-EventsTable-3M4N5O6P7Q8R`
- **THEN** the `SyncReport` references the path `dynamo/tables/EventsTable.md` (the logical name), not the suffixed live name

#### Scenario: Re-deploy with a new suffix updates the same file

- **WHEN** a folder already contains `dynamo/tables/EventsTable.md` from a prior sync, the rule strips the prefix and random suffix, and the connection re-syncs after a deploy that renamed the live table to `MyApp-prod-EventsTable-9Z8Y7X6W5V4U`
- **THEN** `dynamo/tables/EventsTable.md` is updated in place (its `human:` block and body preserved) and no new suffixed file is created

#### Scenario: Colliding live tables are skipped with a warning

- **WHEN** an over-broad rule normalizes two distinct live tables `MyApp-prod-Events-AAAA` and `MyApp-prod-Events-BBBB` both to the logical name `Events` within one sync
- **THEN** the first is written to `dynamo/tables/Events.md`, the second is skipped, and the `SyncReport` surfaces the skipped collision; the sync does not abort

#### Scenario: Athena connection produces a sync report

- **WHEN** the user invokes `context_sync_schema` on a connected Athena connection whose linked folder is empty
- **THEN** the command returns a `SyncReport` whose `created` list contains one path per Glue relation, each path of the form `athena/<database>/<relation>.md`
- **AND** each created file's `system.kind` is `"table"` or `"view"` (view when the Glue `TableType` is `VIRTUAL_VIEW`), `system.schema` matches the Glue database, `system.primary_key` is empty, and `system.columns` contains the storage-descriptor columns followed by partition keys

#### Scenario: Existing files preserve human and body across all engines

- **WHEN** a MySQL/MSSQL/Dynamo/Athena connection re-runs `context_sync_schema` on a folder where some object files already exist with hand-edited `human:` blocks and Markdown bodies
- **THEN** every existing file's `human:` block and body are preserved byte-for-byte
- **AND** the `system:` block is replaced to reflect the current source schema

### Requirement: Introspector pools bundle

The internal `introspector_for(engine, pools)` dispatcher SHALL accept an `IntrospectorPools` struct containing references to all wired engine registries (`PgPoolRegistry`, `MysqlPoolRegistry`, `MssqlPoolRegistry`, `DynamoClientRegistry`, `AthenaClientRegistry`). The `context_sync_schema` Tauri command SHALL receive each registry as a `State<>` parameter, assemble the bundle, and pass it to the dispatcher. Engines not yet wired (CloudWatch) continue to dispatch to `NotImplementedIntrospector`.

#### Scenario: Athena dispatches to its introspector

- **WHEN** `context_sync_schema` is invoked on a connection whose `kind` is `athena`
- **THEN** the dispatcher routes to `AthenaIntrospector` using the `AthenaClientRegistry` from the bundle

#### Scenario: CloudWatch still returns NotImplemented

- **WHEN** `context_sync_schema` is invoked on a connection whose `kind` is `cloudwatch`
- **THEN** the command returns `AppError::Internal` with a message identifying the engine as not yet wired

#### Scenario: Postgres path is unchanged

- **WHEN** `context_sync_schema` is invoked on a Postgres connection
- **THEN** the command returns the same `SyncReport` shape and behaviour as before this change

