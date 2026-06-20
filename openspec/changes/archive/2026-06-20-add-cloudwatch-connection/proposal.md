## Why

Argus supports Postgres, MySQL, MSSQL, DynamoDB and Athena, but **CloudWatch Logs** exists only as a reserved enum (`EngineKind::Cloudwatch`) and a reserved query extension (`.cwlogs`) — there is no adapter, client, form, commands, or introspector. Operators who already manage their warehouses in Argus have no way to inspect application logs from the same tool. The two hardest pieces already exist and are reused unchanged: the **AWS credential chain** (DynamoDB — profile/access-keys, keychain secrets, profile enumeration) and the **async query lifecycle + generic export** (Athena — `Start → poll → fetch`, CSV/JSONL/XLSX). The remaining work is CloudWatch-specific: a log-group/stream browser, a raw event tail, and a **Logs Insights** editor whose query parameters (log groups + time range) live *outside* the query string, unlike SQL.

## What Changes

- **New CloudWatch connection kind** (`"cloudwatch"`): create / test / edit / duplicate connections with a region and an AWS auth method (profile or access keys) — reusing the DynamoDB credential chain and profile enumeration. Credentials live in the OS keychain like every other connection secret. CloudWatch Logs is **read-only by nature**, so the connection carries no `read_only` flag.
- **Log browser (tree)**: a sidebar tree of **log groups → log streams**. Log groups load paginated (`DescribeLogGroups`); streams load lazily per group, newest-first (`DescribeLogStreams`, `orderBy: LastEventTime`).
- **Raw event tail**: activating a log-stream leaf opens a read-only **events viewer** (timestamp + message) backed by `GetLogEvents`, with "load older / newer" paging via the forward/backward tokens. No inline editing (logs are immutable).
- **Logs Insights editor**: a CodeMirror editor for `.cwlogs` queries whose **toolbar** carries the two parameters Insights needs alongside the query body — a **multi-select of log groups** and a **time-range picker** (relative presets + absolute). Execution runs the Insights lifecycle `StartQuery → poll GetQueryResults → terminal state`, with cancellation via `StopQuery`. Results have a **dynamic column set** (the union of field names returned, with `@timestamp`/`@message`/`@ptr` ordered first), a row cap with a `truncated` flag, **records/bytes-scanned (cost) shown per run**, and CSV/JSONL/XLSX export reusing the generic exporter.
- **Context-folder support for CloudWatch**: a new `CloudwatchIntrospector` syncs log groups into the linked folder at `cloudwatch/groups/<name>.md`. Because log-group names contain `/` (e.g. `/aws/lambda/fn`), names are folded to flat filenames with a **simple `/` → `__` rule** (`__aws__lambda__fn.md`) applied symmetrically in `context/sync.rs` (write) and `context/parser.rs` (read). The `EngineKind::Cloudwatch` enum, `subtree()`, `query_extensions() → ["cwlogs"]`, and the `cloudwatch/groups/*` parser/sync arms already exist; this change replaces the `NotImplementedIntrospector` dispatch with the real one.
- **Dependencies**: add `aws-sdk-cloudwatchlogs` to `src-tauri/Cargo.toml` (reuse existing `aws-config` / `aws-sdk-sts`).

## Capabilities

### New Capabilities
- `cloudwatch-connection`: CloudWatch connection lifecycle and parameters (region, AWS auth via profile/access-keys), AWS client registry, and test/connect/disconnect/list-active commands.
- `cloudwatch-logs-browser`: log-group/stream tree (paginated groups, lazy streams) and the raw event tail viewer (`GetLogEvents` with forward/backward paging).
- `cloudwatch-insights-editor`: the Logs Insights editor and execution — toolbar log-group multi-select + time-range picker, the `StartQuery → poll → fetch` lifecycle, cancellation, dynamic-column result shaping, row cap, records/bytes-scanned cost, and CSV/JSONL/XLSX export.

### Modified Capabilities
- `connection-context-folders`: requirements extended so schema-sync introspects CloudWatch log groups through `aws-sdk-cloudwatchlogs` into `cloudwatch/groups/<name>.md`, using the `/` → `__` filename folding, and so the introspector dispatcher routes `cloudwatch` to `CloudwatchIntrospector` instead of `NotImplementedIntrospector`.

## Impact

- **Backend (`src-tauri/`)**: new `modules/cloudwatch/` module (`params`, `client` + registry, `commands`, `groups` for groups/streams/events, `insights` for the query lifecycle, `errors`); `CloudwatchIntrospector` + `IntrospectorPools.cloudwatch` field wired into `context_sync_schema` (`context/commands.rs`); the `/` → `__` folding added to `context/sync.rs` (`target_path_for`) and reversed in `context/parser.rs`; `mod cloudwatch;` in `modules/mod.rs`; `app.manage(CloudwatchClientRegistry::new())` and ~8 new commands registered in `lib.rs`. The `EngineKind::Cloudwatch` enum wiring already exists. Errors reuse `AppError::Aws` (like DynamoDB/Athena).
- **Frontend (`src/`)**: new `modules/cloudwatch/` (types/`CLOUDWATCH_KIND`, api, icon, ConnectionForm, FormController, `useActiveConnections`, `schema/LogGroupsTree`, `events/EventsTab` raw tail, `insights/QueryEditor`/`QueryTab` + toolbar group-select + time-range picker + `ResultPanel`); new per-`kind` branches in the shell connection row/subtree and a card in `platform/shell/useKindPicker.tsx`; tab registration via side-effect import in the module barrel.
- **No change** to connection persistence or secret storage (engine-agnostic — `kind` is a string, params are JSON, secrets keyed by `connection:{id}`).
- **Docs**: `README.md` "Supported Sources" + CloudWatch setup/IAM permissions; `CLAUDE.md` supported-sources list and the context-folder note (CloudWatch moves from "on the roadmap" to shipped); icon per `DESIGN.md`.
- **External**: requires IAM `logs:DescribeLogGroups`, `logs:DescribeLogStreams`, `logs:GetLogEvents`, `logs:StartQuery`, `logs:GetQueryResults`, `logs:StopQuery` (and `sts:GetCallerIdentity` for the identity check). Logs Insights is billed by **bytes scanned** per query; the time range and selected log groups bound that cost.

## Non-goals

- **Live Tail** (`StartLiveTail` streaming API) — the event tail is poll/paged, not a live stream. Follow-up.
- **CloudWatch Metrics / alarms / dashboards** — this change is CloudWatch **Logs** only.
- **Cross-account / non-default catalogs**, `.cwlogs` saved-query prefabs in the context folder, and AI-assisted Insights generation — all deferred to follow-ups (the `.cwlogs` extension is reserved so prefabs slot in later).
- **Editing log events** — logs are immutable; there is no data grid.
