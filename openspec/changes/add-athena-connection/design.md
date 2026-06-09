## Context

Argus already ships five sources. Adding AWS Athena is net-new, but two of the three hard problems are solved elsewhere in the tree:

- **AWS credentials** — `modules/dynamo/{client.rs, aws_profiles.rs}` resolve profiles, SSO, and static access-keys, store secrets in the OS keychain (`connection:{id}`), and classify AWS errors (expired token/SSO, access-denied). DynamoDB also uses an in-memory **client registry** (`DynamoClientRegistry`) rather than a `sqlx` pool — exactly the right shape for Athena.
- **SQL editor** — `modules/mysql/sql/*` (CodeMirror + `@codemirror/lang-sql`, `splitStatements`, `ResultPanel`, CSV/JSONL/XLSX export) and the frontend module/registration patterns are directly reusable.

The genuinely new part is Athena's **asynchronous query lifecycle** (`StartQueryExecution` → poll `GetQueryExecution` → paginate `GetQueryResults`) and **Glue-based introspection**. Athena is not a connection — it is a request/response service — so the "pool" in the issue is really a client registry.

The change must also satisfy two explicit asks: the engine participates in the **context-folder** system (schema sync via Glue), and the SQL editor exposes **AI SQL generation** grounded in that context folder (the ✨ panel already used by Postgres).

Connection persistence and secrets are engine-agnostic (`kind` is a string, `params` is opaque JSON, secrets keyed by `connection:{id}`), so no storage changes are needed.

## Goals / Non-Goals

**Goals:**
- Create/test/edit/duplicate Athena connections (region, workgroup, S3 output location, AWS auth via profile or access-keys), reusing the DynamoDB credential chain and profile enumeration.
- Execute single and multi-statement SQL through the Athena lifecycle, with cancellation, read-only enforcement, row cap, header-row handling, string→typed coercion, bytes-scanned (cost) reporting, and CSV/JSONL/XLSX export.
- Browse Glue databases/tables/views/columns in the sidebar; table click opens a `SELECT … LIMIT 100` preview tab; completion caches feed autocompletion.
- Schema-sync Glue introspection into the linked context folder (`athena/<database>/<relation>.md`).
- Enable the context-folder-grounded ✨ AI chat panel in the Athena SQL editor.

**Non-Goals:**
- No inline-editing data grid and no `COUNT(*)`-backed paginated table viewer (Athena is read-mostly and counts cost money). Table interaction is "open a SELECT preview".
- No federated / non-default data catalogs (`AwsDataCatalog` only in v1).
- No CloudWatch-style streaming, no Iceberg-specific write UX, no cost guardrails/quotas beyond *displaying* bytes scanned.
- No new connection-string URL parser (Athena has no canonical connection URL).
- No dedicated `AppError::Athena` variant in v1 (reuse `AppError::Aws`).

## Decisions

### D1 — Client registry, not a pool
Model active connections with an `AthenaClientRegistry` (map `Uuid → { athena_client, glue_client, account_id, region, read_only, connected_at }`), mirroring `DynamoClientRegistry`. `athena_connect` builds the clients via a `build_athena_clients(params, secret)` function cloned from `build_dynamo_client` and verifies with `sts:GetCallerIdentity` (and optionally `athena:GetWorkGroup`). _Alternative rejected:_ faking a `sqlx`-style pool — there is no persistent connection to pool.

### D2 — Query execution is an explicit state machine
`athena_run_sql` implements: `StartQueryExecution` → poll `GetQueryExecution` with bounded backoff until `SUCCEEDED|FAILED|CANCELLED` → on success page `GetQueryResults`. Polling is the part with no analog in `mysql/sql.rs`; everything around it (activity-log emission, `is_mutating_sql` read-only gate, result envelope shape) is copied from MySQL. _Alternative rejected:_ Athena's newer "result reuse"/streaming APIs — unnecessary complexity for v1.

### D3 — Result typing: coerce from strings using `ResultSetMetadata`
`GetQueryResults` returns every cell as a string plus per-column Athena/Presto type info. We map types → JSON (`integer/bigint/double/decimal` → number, `boolean` → bool, `date/timestamp` → string-as-is for now, absent `VarCharValue` → `null`, else string). This replaces MySQL's `binding.rs` typed decode with a simpler string-coercion layer. The first `SELECT` result row repeats the column labels — a known Athena quirk — and is dropped.

### D4 — Cost is surfaced, not gated
Read `Statistics.DataScannedInBytes` from `GetQueryExecution` and return `data_scanned_bytes` in every result envelope; the editor displays it. No hard quota in v1. _Rationale:_ visibility is cheap and high-value; enforcement is a product decision for later.

### D5 — Multi-statement = N sequential executions
Athena `StartQueryExecution` runs exactly one statement. `athena_run_sql_many` reuses the SQL splitter and runs each statement as its own execution, stopping at first failure (remaining skipped), returning a `{ outcomes: [...] }` envelope like `mysql_run_sql_many`. Each outcome carries its own bytes-scanned so multi-run cost is transparent.

### D6 — Cancellation via `StopQueryExecution`
`athena_run_sql` exposes the `QueryExecutionId` to the frontend (event or progressive return), and `athena_cancel_query(id, query_execution_id)` calls `StopQueryExecution`. This replaces MySQL's `KILL QUERY`/`cancel.rs`.

### D7 — Introspection via Glue; Athena is "SQL-shaped" for the context folder
`AthenaIntrospector` (new in `introspect_adapters.rs`) uses Glue `GetDatabases`/`GetTables` to emit `ObjectShape { kind: table|view, schema: Some(database), primary_key: [], columns: storage_cols + partition_keys }`. `EngineKind::Athena` is grouped with `Postgres | Mysql | Mssql` in `engine.rs`/`sync.rs`/`parser.rs` (subtree `athena`, `query_extensions() → ["sql"]`), so the file layout is `athena/<database>/<relation>.md`. `IntrospectorPools` gains an `athena` field and `context_sync_schema` gains an `AthenaClientRegistry` `State<>` param.

### D8 — Table click opens a SELECT preview, not a grid
The Athena schema tree mirrors the MySQL tree, but activating a table leaf opens a new SQL editor tab pre-filled with `SELECT * FROM "<db>"."<rel>" LIMIT 100`, unexecuted. _Rationale:_ avoids billing a scan on a click, and reuses the editor instead of a bespoke read-only grid. (D8 keeps the door open for a real preview grid later if desired.)

### D9 — AI panel reuse
Reuse the existing AI chat panel and provider plumbing (the `ChatRequest`/context-folder serialisation and `attached_results` path). Wiring is: enable the ✨ toolbar toggle in the Athena editor and route the active Athena connection's linked context folder into the request — the same integration Postgres already has. No new provider code.

### D10 — Errors reuse `AppError::Aws`
Like DynamoDB, surface Athena/Glue failures as `AppError::Aws(AwsErrorBody)`, including the expired-credential remediation hints. A dedicated `AppError::Athena` (carrying `query_execution_id`, state-change reason) can be added later if the UI needs structured query-failure fields; v1 puts the `StateChangeReason` in the message.

### D11 — Tab registration via side-effect import
Register the Athena query tab and any placeholder tab through a **bare `import "./AthenaXxxTab"`** (value/side-effect) in the module barrel, never `export type`, so `TabRegistry.register` actually runs (the MSSQL tree-shaking bug the issue calls out).

## Risks / Trade-offs

- **Query cost from accidental runs** → Table click only *pre-fills* a SELECT; nothing executes until the user runs it. Bytes-scanned is shown after every run (D4).
- **Athena header-row quirk produces a phantom first row** → Explicitly detect-and-drop the label row for `SELECT` (D3); cover with a unit test using a recorded `GetQueryResults` page.
- **All values arrive as strings** → Centralise coercion in one typed mapper keyed by `ColumnInfo.Type`; default to string on unknown types so nothing is lost.
- **Polling latency / unbounded waits** → Bounded total timeout with backoff; cancel path via `StopQueryExecution` (D6); surface `QUEUED`/`RUNNING` state to the editor so the user isn't staring at a frozen UI.
- **Workgroup enforces output location vs. params provides one** → Only pass `ResultConfiguration.OutputLocation` when the workgroup does not enforce one; validate `output_location` as an `s3://` URI when present; surface Athena's own "output location required" error verbatim otherwise.
- **Frontend blast radius wider than the issue states** → `ConnectionRow.tsx` has ~8 per-`kind` branches (connect/disconnect/icon/active-state/subtree) plus `useKindPicker`. Enumerated in tasks so none is missed.
- **IAM under-provisioning is the likely top support issue** → Document the minimum policy (`athena:{Start,Get,Stop}QueryExecution`, `athena:GetQueryResults`, `glue:Get{Databases,Tables,Table}`, `s3:{GetObject,PutObject,ListBucket}` on output location + data buckets) in README; the test-connection error messages should hint at access-denied.
- **Multi-statement cost multiplies silently** → Each statement is a billed execution; surface per-outcome bytes-scanned and consider a confirm for large batches (out of v1 scope but noted).

## Migration Plan

Additive only — no schema migration, no change to existing connections. Deploy is a normal release. Rollback is removing the Athena module and its registrations; existing connections of other kinds are unaffected. The catch-all arm in `introspector_for` means an `EngineKind::Athena` value never panics even mid-rollout.

## Open Questions

- Display format for `date`/`timestamp` cells — pass Athena's string through verbatim (current plan) or normalise? Defer to first QA pass.
- Should the test-connection check call `athena:GetWorkGroup` (validates workgroup + output-location enforcement up front) in addition to `sts:GetCallerIdentity`? Leaning yes; confirm IAM cost.
- Do we want a lightweight per-run confirmation when estimated/last scan exceeds a threshold? Out of v1, but worth a follow-up if users hit surprise bills.
