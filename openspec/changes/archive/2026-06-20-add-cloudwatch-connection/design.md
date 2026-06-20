## Context

`EngineKind::Cloudwatch` and the `.cwlogs` extension already exist (`context/engine.rs`), and `context/sync.rs`/`context/parser.rs` already have `cloudwatch/groups/*.md` arms — but everything functional is missing: no backend module, no introspector (the dispatcher returns `NotImplementedIntrospector`), no frontend module, no shell wiring. This change fills that gap.

Two existing subsystems are reused **verbatim**:

1. **AWS auth (DynamoDB)** — `dynamo::aws_profiles::list_profiles`, the access-keys-JSON-vs-named-profile credential resolution, `sts:GetCallerIdentity` verification, and the keychain secret shape `{ access_key_id, secret_access_key, session_token? }`.
2. **Async query lifecycle + export (Athena)** — the backend-blocking `Start → poll(backoff) → fetch(paged, row-capped, truncated flag)` Tauri command shape, and the frontend generic exporter (`columns:{name,ty}[] + rows[][]` → CSV/JSONL/XLSX).

CloudWatch differs from both in three ways that drive the design below.

## Key decisions

### 1. Insights parameters live outside the query string

Athena puts everything in the SQL. Logs Insights `StartQuery` takes three *separate* inputs:

```
StartQuery(
  logGroupIdentifiers: [ ... ],   ← multi-select (≤ 50), toolbar control
  startTime / endTime: epoch_s,   ← time-range picker, toolbar control
  queryString: "fields @timestamp, @message | filter ... | sort ... | limit N",
  limit: <row cap>,
)
```

**Decision:** the `.cwlogs` editor is a CodeMirror body **plus a toolbar** owning the log-group multi-select and the time-range picker. `useQueryRun` assembles `{ logGroupIdentifiers, startTime, endTime, queryString }` from toolbar + editor and passes them to `cloudwatch_run_insights`. The selected groups default to whatever the user has expanded/checked in the tree for that connection; the time range defaults to "last 1h".

**Time range:** relative presets (`5m, 15m, 1h, 3h, 12h, 1d, 1w`) + a custom absolute range. The frontend resolves the relative preset to concrete epoch seconds **at run time** (not at selection time) and sends absolute `startTime`/`endTime` to the backend, so the backend stays clock-agnostic and re-runs use a fresh window.

**Editor language:** the Insights query language is not SQL. v1 uses CodeMirror with lightweight tokenizing only (pipe `|`, command keywords `fields/filter/stats/sort/limit/parse/display`, comments) — no autocomplete from a schema (Insights has no fixed schema). Reserved for a follow-up.

### 2. Dynamic columns from `GetQueryResults`

Insights returns `results: [[{ field, value }]]` where the field set varies per query and per row. There is no `ResultSetMetadata`.

**Decision:** the backend builds the column list as the **union of field names in order of first appearance**, with the synthetic fields ordered first when present: `@timestamp`, then `@message`, then any user fields, with `@ptr` last (it is the dedup pointer, rarely interesting). Each row is projected onto that column order; missing fields render as `null`. Column `ty` is reported as `"string"` for all columns (Insights values are strings) so the generic exporter and grid work unchanged. The returned envelope mirrors Athena's `Rows { columns, rows, query_ms, truncated, records_matched, records_scanned, bytes_scanned }`.

### 3. Log-group names contain `/` → flat-file folding for context sync

`target_path_for` (sync.rs:62) currently does `groups/<name>.md`. A real group `/aws/lambda/fn` would create nested dirs `groups/aws/lambda/fn.md`, but `parser.rs` reads `groups/` **non-recursively** — a latent write/read mismatch.

**Decision (simple, per user):** fold the logical group name to a flat filename with `/` → `__`:

```
   logical name              file (under cloudwatch/groups/)
   ───────────────────────   ──────────────────────────────
   /aws/lambda/checkout   →   __aws__lambda__checkout.md
   my-app/api             →   my-app__api.md
```

The fold is applied in `sync.rs::target_path_for` (write) and **reversed** in `parser.rs` when reconstructing the object name from the filename (read), so round-trips match the same file. Known limitation (documented): a literal `__` in a group name is ambiguous on reverse; acceptable for v1 — CloudWatch group names overwhelmingly use `/`, not `__`. The `system.kind` is `"log_group"`; `system.schema` is omitted; `system.columns` and `system.primary_key` are empty (log groups have no columns). Optional metadata (`retentionInDays`, `storedBytes`) MAY be carried in the `system:` block but is not required for v1.

### 4. Raw event tail uses `GetLogEvents`, paged not streamed

Activating a stream leaf opens an events tab (read-only). `GetLogEvents` returns events plus `nextForwardToken`/`nextBackwardToken`. v1 loads the most recent page (`startFromHead: false`) and exposes "load older" (backward token) / "load newer" (forward token) actions. `FilterLogEvents` (group-wide, no stream) and `StartLiveTail` (streaming) are out of scope — see proposal Non-goals.

## Backend module shape

```
src-tauri/src/modules/cloudwatch/
  mod.rs        re-exports
  params.rs     CloudwatchParams { region, auth: "profile"|"access_keys", profile? }   (no read_only)
  client.rs     build_cloudwatch_client(params, secret) + CloudwatchClientRegistry (RwLock<HashMap<Uuid, Active>>)
  commands.rs   cloudwatch_test_connection / _connect / _disconnect / _disconnect_all / _list_active
  groups.rs     cloudwatch_list_log_groups, cloudwatch_list_log_streams, cloudwatch_get_log_events
  insights.rs   cloudwatch_run_insights (Start→poll→fetch), cloudwatch_cancel_insights (StopQuery)
  errors.rs     reuse dynamo AWS error classification (expired token / SSO / access-denied hints)
```

Auth, registry, STS verification, and error classification are near-verbatim copies of the DynamoDB module (`dynamo/aws_profiles.rs` is imported directly, not duplicated). The Insights lifecycle copies Athena's `sql.rs` poll/backoff/timeout/cancel structure.

## Frontend module shape

```
src/modules/cloudwatch/
  types.ts          CLOUDWATCH_KIND = "cloudwatch", CloudwatchParams, result + event types
  api.ts            invoke wrappers
  icon.tsx          per DESIGN.md
  ConnectionForm.tsx + FormController.tsx   (clone Athena AWS-auth form, minus workgroup/output/read-only)
  useActiveConnections.ts                   (subscribe cloudwatch:active-changed)
  schema/LogGroupsTree.tsx                  (groups → lazy streams)
  events/EventsTab.tsx + openEventsTab.ts   (raw tail viewer, older/newer paging)
  insights/QueryTab.tsx                     (toolbar + editor + ResultPanel)
  insights/QueryEditor.tsx                  (CodeMirror .cwlogs)
  insights/Toolbar.tsx                      (log-group multi-select + time-range picker)
  insights/useQueryRun.ts                   (assemble params, run, cancel)
  index.ts          barrel — register query + events tabs via side-effect import
```

Export reuses the existing generic exporter (no new export code). Result grid reuses the platform virtualized grid.

## Risks / trade-offs

- **Bytes-scanned cost**: Insights bills by data scanned over the time window. Mitigation: default window is short (1h), the cost is shown per run, and the toolbar makes the window explicit before the user runs.
- **`__` folding ambiguity** (decision 3): accepted for v1; the alternative (percent-encoding or a sidecar manifest) is heavier than the value.
- **No autocomplete in the Insights editor**: acceptable — Insights has no fixed schema and the language is small; deferred.
- **Stream count**: busy groups have thousands of streams; the tree loads them lazily, newest-first, paginated, and never eagerly expands.

## Migration

None. New `kind` value; existing connections, persistence, and secret storage are untouched (engine-agnostic). No schema migration. The reserved `.cwlogs` extension and `EngineKind::Cloudwatch` enum mean no breaking changes to the context-folder layout.
