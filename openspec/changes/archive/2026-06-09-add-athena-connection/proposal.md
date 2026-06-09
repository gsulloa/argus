## Why

Argus supports Postgres, MySQL, MSSQL, DynamoDB and CloudWatch, but has no way to query data lakes through **AWS Athena** — the most common serverless SQL engine over S3. Athena is net-new, yet the two hardest pieces already exist in the codebase: the AWS credential chain (DynamoDB) and the SQL-editor stack (MySQL). The remaining work is the Athena-specific query lifecycle (async start → poll → fetch) and Glue-based schema introspection. Adding it unlocks data-lake querying for users who already manage their warehouses in Argus, with the same context-folder and AI-assisted authoring they get on the other SQL engines.

## What Changes

- **New Athena connection kind** (`"athena"`): create / test / edit / duplicate connections with region, **workgroup**, **S3 output location**, and an AWS auth method (profile or access keys) — reusing the DynamoDB credential chain and profile enumeration. AWS credentials live in the OS keychain like every other connection secret.
- **Athena SQL editor**: a CodeMirror editor (cloned from MySQL) that executes statements through the Athena lifecycle — `StartQueryExecution` → poll `GetQueryExecution` → paginated `GetQueryResults` — with cancellation via `StopQueryExecution`, the column-header quirk handled, string→typed value coercion from `ResultSetMetadata`, a row cap, **bytes-scanned (cost) shown per run**, multi-statement runs (sequential, one execution each), CSV/JSONL/XLSX export, and read-only enforcement (reject non-`SELECT` when the connection is read-only).
- **AI-assisted SQL generation in the Athena editor**: the ✨ chat panel (already wired for Postgres) is enabled in the Athena SQL editor, streaming from the configured AI providers and grounded in the connection's **context folder** so the agent writes Athena/Presto-dialect SQL against the real schema.
- **Glue schema browser**: sidebar tree of Glue databases → tables → columns (views detected via `TableType = VIRTUAL_VIEW`), backed by `glue:GetDatabases`/`GetTables`. Clicking a table opens a `SELECT * FROM db.table LIMIT 100` preview in a new editor tab (no inline editing — Athena is read-mostly; no `COUNT(*)` data grid to avoid scan cost). Completion caches (schemas/tables/columns) populate from the tree so the editor autocompletes.
- **Context-folder support for Athena**: `EngineKind` gains an `Athena` variant grouped with the SQL engines (subtree `athena/<database>/<table>.md`, query extension `sql`); schema-sync writes Glue-introspected object docs into the linked context folder via a new `AthenaIntrospector`.
- **Dependencies**: add `aws-sdk-athena` and `aws-sdk-glue` to `src-tauri/Cargo.toml` (reuse existing `aws-config` / `aws-sdk-sts`).

## Capabilities

### New Capabilities
- `athena-connection`: Athena connection lifecycle and parameters (region, workgroup, S3 output location, AWS auth via profile/access-keys), AWS client registry, test/connect/disconnect/list-active commands, and read-only flag.
- `athena-sql-editor`: SQL editor and execution for Athena — async query lifecycle, cancellation, result shaping (header-row handling, string→typed coercion, row cap, bytes-scanned), multi-statement runs, export, read-only enforcement, and the context-folder-grounded AI chat panel for SQL generation.
- `athena-schema-browser`: Glue-backed schema tree (databases/tables/columns/views), table-preview-via-SELECT, and the completion caches that feed editor autocompletion.

### Modified Capabilities
- `connection-context-folders`: requirements extended so the context-folder system recognises the Athena engine (subtree, `sql` query extension) and the schema-sync flow introspects Athena schemas through AWS Glue into the linked context folder.

## Impact

- **Backend (`src-tauri/`)**: new `modules/athena/` module (params, client + registry, sql execution, schema commands, errors); `EngineKind::Athena` in `modules/context/engine.rs` plus the grouped match arms in `context/sync.rs` and `context/parser.rs`; new `AthenaIntrospector` + `IntrospectorPools.athena` field wired into `context_sync_schema` (`context/commands.rs`); `mod athena;` in `modules/mod.rs`; `app.manage(AthenaClientRegistry::new())` and ~6–8 new commands registered in `lib.rs`. Errors reuse `AppError::Aws` (like DynamoDB) for v1.
- **Frontend (`src/`)**: new `modules/athena/` (types/`ATHENA_KIND`, api, icon, ConnectionForm, FormController, `schema/SchemaTree` + `globalSchemaCache`, `sql/QueryEditor`/`QueryTab` + `columnsCache`, `useActiveConnections`); new per-`kind` branches in `platform/shell/ConnectionRow.tsx` (connect/disconnect/icon/active-state/subtree) and a card in `platform/shell/useKindPicker.tsx`; tab registration via side-effect import in the module barrel.
- **No change** to connection persistence or secret storage (both engine-agnostic — `kind` is a string, params are JSON, secrets keyed by `connection:{id}`).
- **Docs**: `README.md` "Supported Sources" + Athena setup/IAM permissions; `CLAUDE.md` supported-sources list; icon per `DESIGN.md`.
- **External / cost**: each query scans S3 and is billed by bytes scanned; multi-statement and table-preview each incur scan cost. Requires IAM: `athena:{Start,Get,Stop}QueryExecution`, `athena:GetQueryResults`, `glue:Get{Databases,Tables,Table}`, `s3:{GetObject,PutObject,ListBucket}` on the output location and underlying data buckets.
