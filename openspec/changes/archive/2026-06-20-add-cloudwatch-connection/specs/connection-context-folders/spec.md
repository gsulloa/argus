## ADDED Requirements

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

## MODIFIED Requirements

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
