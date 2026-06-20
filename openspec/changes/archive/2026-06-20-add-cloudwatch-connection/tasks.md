## 1. Scaffolding & dependencies

- [x] 1.1 Add `aws-sdk-cloudwatchlogs` to `src-tauri/Cargo.toml` (reuse existing `aws-config`, `aws-sdk-sts`); confirm the version aligns with the pinned `aws-config` / `aws-smithy-runtime-api`
- [x] 1.2 Create `src-tauri/src/modules/cloudwatch/mod.rs` and declare `pub mod cloudwatch;` in `src-tauri/src/modules/mod.rs` (after `athena`)
- [x] 1.3 Confirm the existing `EngineKind::Cloudwatch` wiring in `context/engine.rs` (variant, `from_connection_kind("cloudwatch")`, `subtree() -> "cloudwatch"`, `query_extensions() -> &["cwlogs"]`) is complete; no enum change needed

## 2. Backend — auth & connection lifecycle (cloudwatch-connection)

- [x] 2.1 `cloudwatch/params.rs`: `CloudwatchParams { region, auth, profile? }`, `CloudwatchAuth` enum (`profile`/`access_keys`), `validate()` (region in AWS list, profile required for profile auth), `from_json`/`to_json`. **No `read_only`** — CloudWatch Logs is read-only by nature
- [x] 2.2 `cloudwatch/client.rs`: `build_cloudwatch_client(params, secret)` cloning the DynamoDB credential resolution (access-keys JSON secret vs named profile), constructing the CloudWatch Logs client, verifying with `sts:GetCallerIdentity`; define `BuiltClient { client, account_id, identity_arn, region }`
- [x] 2.3 `cloudwatch/client.rs` registry: `CloudwatchClientRegistry` (`RwLock<HashMap<Uuid, ActiveCloudwatchClient>>`), `insert/remove/list_active/acquire/snapshot`, `ActiveCloudwatchClientView { id, region, account_id, identity_arn, connected_at_unix_ms }`
- [x] 2.4 `cloudwatch/commands.rs`: `cloudwatch_test_connection`, `cloudwatch_connect`, `cloudwatch_disconnect`, `cloudwatch_disconnect_all`, `cloudwatch_list_active`; emit `argus:activity-log` and `cloudwatch:active-changed` events matching the Dynamo/Athena contracts; `cloudwatch_connect` idempotent
- [x] 2.5 `cloudwatch/errors.rs`: map CloudWatch Logs SDK errors to `AppError::Aws` reusing the DynamoDB AWS error classification + remediation hints (expired token / SSO / access-denied); reuse `dynamo::aws_profiles::list_profiles` for the form (no new profile command)
- [x] 2.6 Register `app.manage(CloudwatchClientRegistry::new())` and all connection commands in `src-tauri/src/lib.rs` `generate_handler!`

## 3. Backend — log browser & raw event tail (cloudwatch-logs-browser)

- [x] 3.1 `cloudwatch/groups.rs` — `cloudwatch_list_log_groups(connection_id, next_token?, limit?)`: `DescribeLogGroups` paged; return `{ groups: [{ name, arn, stored_bytes?, retention_in_days? }], next_token? }`
- [x] 3.2 `cloudwatch_list_log_streams(connection_id, group_name, next_token?, limit?)`: `DescribeLogStreams` with `order_by: LastEventTime`, `descending: true`, paged; return `{ streams: [{ name, last_event_ts?, first_event_ts?, stored_bytes? }], next_token? }`
- [x] 3.3 `cloudwatch_get_log_events(connection_id, group_name, stream_name, forward_token?, backward_token?, start_from_head?, limit?)`: `GetLogEvents`; return `{ events: [{ ts, ingestion_ts, message }], next_forward_token, next_backward_token }` so the frontend can page older/newer
- [x] 3.4 Register the three browser commands in `lib.rs`; backend unit test for the event-token paging shape

## 4. Backend — Logs Insights execution (cloudwatch-insights-editor)

- [x] 4.1 `cloudwatch/insights.rs` result envelope: `InsightsResult::Rows { columns: [{ name, ty }], rows: [[JsonValue]], query_ms, truncated, records_matched, records_scanned, bytes_scanned }`
- [x] 4.2 Lifecycle: `StartQuery(log_group_identifiers, start_time, end_time, query_string, limit)` → poll `GetQueryResults(query_id)` with bounded backoff + total timeout → terminal status handling (`Complete` → results; `Failed`/`Cancelled`/`Timeout` → `AppError::Aws` with the status verbatim). Emit `cloudwatch:query-started` with the `query_id` so the frontend can cancel
- [x] 4.3 Dynamic columns: build the column set as the union of returned field names in first-appearance order, with synthetic fields ordered `@timestamp`, `@message`, …user fields…, `@ptr` last; project each row onto the column order, missing field → `null`; all column `ty` = `"string"`; read `statistics` into `records_matched`/`records_scanned`/`bytes_scanned`; apply a fixed row cap with `truncated`
- [x] 4.4 `cloudwatch_run_insights(connection_id, log_group_identifiers, start_time, end_time, query_string, limit?, origin?)` command: validate ≥1 log group and `start_time < end_time`; emit one `argus:activity-log` event; `origin` default `"user"`
- [x] 4.5 `cloudwatch_cancel_insights(connection_id, query_id)` calling `StopQuery`; register both Insights commands in `lib.rs`
- [x] 4.6 Backend unit test: dynamic-column projection (ragged field sets, synthetic-field ordering, missing → null) against a recorded `GetQueryResults` payload

## 5. Backend — context-folder introspection (connection-context-folders)

- [x] 5.1 `CloudwatchIntrospector` in `context/introspect_adapters.rs`: `DescribeLogGroups` (paged) → emit `ObjectShape { kind: "log_group", schema: None, name: <group name>, primary_key: [], columns: [] }`; add `cloudwatch: &CloudwatchClientRegistry` to `IntrospectorPools` and a match arm in `introspector_for` (replacing the `NotImplemented` fall-through); update/remove the `cloudwatch_returns_not_yet_wired` test
- [x] 5.2 Filename folding: in `context/sync.rs::target_path_for`, fold the log-group name `/` → `__` so the path is `cloudwatch/groups/<folded>.md` (flat, no nested dirs); reverse `__` → `/` in `context/parser.rs` when reconstructing the object name from the filename
- [x] 5.3 Wire `context_sync_schema` in `context/commands.rs`: add `cloudwatch: State<CloudwatchClientRegistry>` param and populate the pools bundle
- [x] 5.4 Backend tests: introspector dispatch for `cloudwatch`, the `/`→`__`→`/` filename round-trip, and a `SyncReport` shape test for `cloudwatch/groups/<folded>.md`

## 6. Frontend — module foundation

- [x] 6.1 `src/modules/cloudwatch/types.ts`: `CLOUDWATCH_KIND = "cloudwatch"`, `CloudwatchParams` interface, log-group/stream/event types, Insights result/summary types
- [x] 6.2 `src/modules/cloudwatch/api.ts`: invoke wrappers for test/connect/disconnect/listActive, listLogGroups/listLogStreams/getLogEvents, runInsights/cancelInsights
- [x] 6.3 `src/modules/cloudwatch/icon.tsx`: CloudWatch Logs icon per `DESIGN.md` (matching the existing engine icon style/stroke)
- [x] 6.4 `src/modules/cloudwatch/ConnectionForm.tsx` + `FormController.tsx`: region + auth (profile/access-keys) fields, AWS profile picker reuse (`dynamo_list_aws_profiles`), test-connection flow, create/edit/duplicate modes — clone the Athena form minus workgroup/output-location/read-only
- [x] 6.5 `src/modules/cloudwatch/useActiveConnections.ts`: subscribe to `cloudwatch:active-changed`, expose `isActive`/`getActive`

## 7. Frontend — log browser & event tail (cloudwatch-logs-browser)

- [x] 7.1 `src/modules/cloudwatch/schema/LogGroupsTree.tsx`: log groups (paged, "load more") → lazy log streams per group (newest-first, paged); never eager-expand streams
- [x] 7.2 `src/modules/cloudwatch/events/EventsTab.tsx` + `openEventsTab.ts`: read-only events viewer (timestamp + message), "load older"/"load newer" via backward/forward tokens; register the tab kind
- [x] 7.3 Stream-leaf activation opens the events tab for `{ connectionId, groupName, streamName }`

## 8. Frontend — Logs Insights editor (cloudwatch-insights-editor)

- [x] 8.1 `src/modules/cloudwatch/insights/QueryEditor.tsx`: CodeMirror for `.cwlogs` with lightweight Insights tokenizing (pipe, command keywords, comments); expose `getQuery()`/`focus()`
- [x] 8.2 `src/modules/cloudwatch/insights/Toolbar.tsx`: log-group **multi-select** (from the connection's groups, ≤ 50) + **time-range picker** (relative presets `5m/15m/1h/3h/12h/1d/1w` + custom absolute); resolve relative → epoch seconds at run time
- [x] 8.3 `src/modules/cloudwatch/insights/useQueryRun.ts`: assemble `{ logGroupIdentifiers, startTime, endTime, queryString, limit }`, call `runInsights`, expose `QUEUED`/`RUNNING` state + cancel; default groups from the tree selection, default range "last 1h"
- [x] 8.4 `src/modules/cloudwatch/insights/QueryTab.tsx` + `ResultPanel`: virtualized grid over dynamic columns; show `records_matched` / `bytes_scanned` (cost) + `RUNNING` state + cancel button; CSV/JSONL/XLSX export reusing the **generic exporter** (no new export code)
- [x] 8.5 `src/modules/cloudwatch/index.ts` barrel: register the Insights query tab and the events tab via **side-effect import** (`import "./insights/QueryTab"`, `import "./events/EventsTab"`); never `export type` from the barrel

## 9. Frontend — shell wiring

- [x] 9.1 `src/platform/shell/useKindPicker.tsx`: add the CloudWatch Logs card (label, description, `CloudwatchIcon`, `openCreate`); add the form hook to the deps array
- [x] 9.2 Add the `isCloudwatch` per-kind branches in the shell connection row/subtree (connect/disconnect, icon, active-state selector, and the `LogGroupsTree` subtree render) following the existing Athena/Dynamo branches; CloudWatch has no `ContextQueriesBranch` in v1

## 10. Docs & verification

- [x] 10.1 `README.md`: add CloudWatch Logs to "Supported Sources" + a setup/IAM section (`logs:DescribeLogGroups/DescribeLogStreams/GetLogEvents/StartQuery/GetQueryResults/StopQuery`, `sts:GetCallerIdentity`); note Insights bytes-scanned billing
- [x] 10.2 `CLAUDE.md`: add CloudWatch Logs to the supported-sources list and move it from "on the roadmap" to shipped in the context-folder note
- [x] 10.3 `cargo test` + `cargo clippy` (backend), `pnpm typecheck` + lint (frontend); manual smoke against a real account: create/test/edit a connection, browse groups → streams, tail a stream (older/newer), run an Insights query with a time range + export, and sync log groups to a context folder
- [x] 10.4 Acceptance criteria (issue #79): create/test/edit a CloudWatch connection from the picker ✓; navigate log groups and streams ✓; run a Logs Insights query (with time range) and see results + export ✓; sync log groups to the context folder ✓
