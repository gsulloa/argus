## 1. Scaffolding & dependencies

- [x] 1.1 Add `aws-sdk-athena` and `aws-sdk-glue` to `src-tauri/Cargo.toml` (reuse existing `aws-config`, `aws-sdk-sts`); confirm versions align with the pinned `aws-config`
- [x] 1.2 Create `src-tauri/src/modules/athena/mod.rs` and declare `pub mod athena;` in `src-tauri/src/modules/mod.rs` (after `dynamo`)
- [x] 1.3 Add `EngineKind::Athena` to `src-tauri/src/modules/context/engine.rs`: variant, `from_connection_kind("athena")`, `subtree() -> "athena"`, `query_extensions() -> &["sql"]`, plus the unit-test arms
- [x] 1.4 Add `EngineKind::Athena` to the SQL-engine match groups in `context/sync.rs` (`target_path_for`, `walk_existing_objects`) and `context/parser.rs` (`load_folder`) so the layout is `athena/<database>/<relation>.md`

## 2. Backend — auth & connection lifecycle (athena-connection)

- [x] 2.1 `athena/params.rs`: `AthenaParams { region, workgroup, output_location?, auth, profile?, read_only }`, `AthenaAuth` enum (`profile`/`access_keys`), `validate()` (region in AWS list, non-empty workgroup, valid `s3://` output_location when present, profile required for profile auth), and `sanitized()` if needed
- [x] 2.2 `athena/client.rs`: `build_athena_clients(params, secret)` cloning the DynamoDB credential resolution (access-keys JSON secret vs named profile), constructing Athena + Glue clients, verifying with `sts:GetCallerIdentity`; define `BuiltClients { athena, glue, account_id }`
- [x] 2.3 `athena/pool.rs` (client registry): `AthenaClientRegistry` (map `Uuid → ActiveAthenaClient`), `connect/disconnect/disconnect_all/list_active/acquire`, `read_only_for`, `ActivePoolSummary { id, region, account_id, read_only, connected_at_unix_ms }`
- [x] 2.4 `athena/commands.rs`: `athena_test_connection`, `athena_connect`, `athena_disconnect`, `athena_disconnect_all`, `athena_list_active`; emit `argus:activity-log` and `athena:active-changed` events matching the MySQL/Dynamo contracts
- [x] 2.5 `athena/errors.rs`: map Athena/Glue SDK errors to `AppError::Aws` reusing the DynamoDB AWS error classification + remediation hints; reuse `aws_profiles::list_profiles`
- [x] 2.6 Register `app.manage(AthenaClientRegistry::new())` and all Athena commands in `src-tauri/src/lib.rs` `generate_handler!`

## 3. Backend — SQL execution (athena-sql-editor)

- [x] 3.1 `athena/sql.rs` result envelopes: `RunSqlResult::{Rows { columns, rows, query_ms, truncated, data_scanned_bytes }, Succeeded { statement_type, query_ms, data_scanned_bytes }}` and the `MultiSqlResult { outcomes }` shape
- [x] 3.2 Implement the query lifecycle: `StartQueryExecution` (database context, workgroup, conditional `ResultConfiguration.OutputLocation`) → poll `GetQueryExecution` with bounded backoff + total timeout → terminal-state handling (`FAILED`/`CANCELLED` → `AppError::Aws` with `StateChangeReason` verbatim)
- [x] 3.3 `GetQueryResults` pagination to a fixed row cap with `truncated` flag; drop the duplicated header row for `SELECT`; read `Statistics.DataScannedInBytes` into `data_scanned_bytes`
- [x] 3.4 String→typed value coercion keyed by `ResultSetMetadata.ColumnInfo.Type` (numeric/boolean/null/else-string); unit-test against a recorded `GetQueryResults` page including the header-row quirk
- [x] 3.5 `athena_run_sql` command: shared `is_mutating_sql` read-only gate BEFORE `StartQueryExecution`; activity-log emission; `origin` default `"user"`
- [x] 3.6 `athena_run_sql_many`: reuse SQL splitter, run statements as sequential executions, stop-at-first-failure with skipped remainder, per-outcome `data_scanned_bytes`
- [x] 3.7 `athena_cancel_query(connection_id, query_execution_id)` calling `StopQueryExecution`; expose the `QueryExecutionId` to the frontend during polling

## 4. Backend — Glue introspection (athena-schema-browser & context folder)

- [x] 4.1 `athena/schema_commands.rs`: `athena_list_databases` (`glue:GetDatabases`, paged), `athena_list_relations(database)` (`glue:GetTables`, paged; `kind: view` when `TableType == VIRTUAL_VIEW`), column extraction from `StorageDescriptor.Columns` + `PartitionKeys`
- [x] 4.2 `AthenaIntrospector` in `context/introspect_adapters.rs`: emit `ObjectShape { kind, schema: Some(database), primary_key: [], columns }`; add `athena: &AthenaClientRegistry` field to `IntrospectorPools` and a match arm in `introspector_for`
- [x] 4.3 Wire `context_sync_schema` in `context/commands.rs`: add `athena: State<AthenaClientRegistry>` param and populate the pools bundle
- [x] 4.4 Backend tests: engine mapping, introspector dispatch for `athena`, and a `SyncReport` shape test for `athena/<database>/<relation>.md`

## 5. Frontend — module foundation

- [x] 5.1 `src/modules/athena/types.ts`: `ATHENA_KIND = "athena"`, `AthenaParams` interface, result/summary types
- [x] 5.2 `src/modules/athena/api.ts`: invoke wrappers for test/connect/disconnect/listActive, runSql/runSqlMany/cancel, listDatabases/listRelations/listColumns
- [x] 5.3 `src/modules/athena/icon.tsx`: Athena icon per `DESIGN.md` (matching the existing engine icon style/stroke)
- [x] 5.4 `src/modules/athena/ConnectionForm.tsx` + `FormController.tsx`: region/workgroup/S3-output/auth fields, AWS profile picker reuse, test-connection flow, create/edit/duplicate modes
- [x] 5.5 `src/modules/athena/useActiveConnections.ts`: subscribe to `athena:active-changed`, expose `isActive`/`getActive`

## 6. Frontend — schema tree, caches & SQL editor

- [x] 6.1 `src/modules/athena/schema/SchemaTree.tsx` (databases → tables/views → columns) + `schema/globalSchemaCache.ts`
- [x] 6.2 `src/modules/athena/sql/columnsCache.ts`: populate from tree, clear on `athena:active-changed` disconnect
- [x] 6.3 `src/modules/athena/sql/QueryEditor.tsx` + `QueryTab.tsx`: clone MySQL editor (CodeMirror + `@codemirror/lang-sql`, completion sources from the caches, `splitStatements`, `ResultPanel`, CSV/JSONL/XLSX export); show `data_scanned_bytes` (cost) and `QUEUED`/`RUNNING` state + cancel button
- [x] 6.4 Table-leaf activation opens a SQL editor tab pre-filled with `SELECT * FROM "<db>"."<rel>" LIMIT 100` (unexecuted)
- [x] 6.5 `src/modules/athena/index.ts` barrel: register the query tab via **side-effect import** (`import "./sql/QueryTab"`), never `export type`

## 7. Frontend — shell wiring

- [x] 7.1 `src/platform/shell/useKindPicker.tsx`: add the Amazon Athena card (label, description, `AthenaIcon`, `openCreate`)
- [x] 7.2 `src/platform/shell/ConnectionRow.tsx`: add `isAthena` branches for connect/disconnect, icon, active-state selector, and subtree render (the Athena `SchemaTree`)

## 8. AI SQL generation (athena-sql-editor)

- [x] 8.1 Enable the ✨ AI chat panel in the Athena SQL editor toolbar (reuse the Postgres panel + provider plumbing); ensure "AI: Focus chat panel" works for Athena tabs
- [x] 8.2 Route the active Athena connection's linked context folder into the `ChatRequest` so generated SQL is Athena/Presto-dialect and schema-grounded
- [x] 8.3 Wire the "Attach result" composer chip for Athena results (existing caps, session-only, `attached_results` field)

## 9. Docs & verification

- [x] 9.1 README "Supported Sources": add Athena, setup steps, and the minimum IAM policy (`athena:{Start,Get,Stop}QueryExecution`, `athena:GetQueryResults`, `glue:Get{Databases,Tables,Table}`, `s3:{GetObject,PutObject,ListBucket}`)
- [x] 9.2 Update `CLAUDE.md` supported-sources list to include Athena
- [ ] 9.3 Manual QA: create/test/edit connection; expand Glue tree; run SELECT + multi-statement; cancel a running query; export CSV/JSONL/XLSX; sync schema to context folder; generate SQL with AI using the context folder
- [x] 9.4 `cargo test`/`cargo clippy` and frontend typecheck/lint pass
