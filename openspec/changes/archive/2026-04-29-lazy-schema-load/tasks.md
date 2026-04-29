## 1. Backend — shared types and helpers

- [x] 1.1 In `src-tauri/src/modules/postgres/schema_types.rs`, add `KindFailure { kind: String, code: Option<String>, message: String }` with `serde::Serialize` and snake_case keys; remove `args_signature` and `return_type` from `FunctionInfo` and add `oid: i64`
- [x] 1.2 Add `RelationsResult { schema, tables, views, materialized_views }`, `StructureResult { schema, functions: Option<Vec<FunctionInfo>>, types: Option<Vec<TypeInfo>>, extensions: Option<Vec<ExtensionInfo>>, failures: Vec<KindFailure> }`, `TableExtrasResult { schema, relation, indexes: Option<Vec<IndexInfo>>, triggers: Option<Vec<TriggerInfo>>, failures: Vec<KindFailure> }`, `FunctionSignature { args_signature: String, return_type: Option<String> }` with `serde::Serialize`
- [x] 1.3 In a new shared helper (`schema_commands.rs` or a small new submodule), implement `fn map_failure(kind: &str, err: AppError) -> KindFailure` that extracts SQLSTATE for `AppError::Postgres`, formats the message, and returns the envelope; collapse permission-denied (42501) to `Ok(Vec::new())` upstream so it never reaches `map_failure`
- [x] 1.4 Refactor the existing `fire_cancel` helper into a free function reusable across the new commands (currently lives in `schema_commands.rs`); take it out as `pub(super) async fn fire_cancel(token, sslmode)` if not already

## 2. Backend — split list_objects into per-group helpers

- [x] 2.1 In `schema.rs`, rename `fetch_data` to `list_relations` and have it return `(Vec<TableInfo>, Vec<ViewInfo>, Vec<ViewInfo>)` instead of mutating an `out: &mut SchemaObjects`; keep the existing UNION-style `SQL_LIST_DATA` query unchanged
- [x] 2.2 Update `SQL_LIST_FUNCTIONS` to drop `pg_get_function_arguments(p.oid)` and `pg_get_function_result(p.oid)` from the SELECT; return `proname, p.oid, l.lanname, d.description` only; update `list_functions` to populate `oid` and leave signature/return type empty
- [x] 2.3 Add `SQL_LIST_TABLE_INDEXES` (parameterized: `WHERE n.nspname = $1 AND t.relname = $2`) and `SQL_LIST_TABLE_TRIGGERS` (analogous filter); add `list_table_indexes(client, schema, relation)` and `list_table_triggers(client, schema, relation)` async helpers
- [x] 2.4 Add `SQL_GET_FUNCTION_SIGNATURE` (`SELECT pg_get_function_arguments($1::oid), pg_get_function_result($1::oid) FROM pg_catalog.pg_proc WHERE oid = $1::oid AND proname = $2 AND pronamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $3)`); add `get_function_signature(client, schema, name, oid)` returning `FunctionSignature` or `AppError::NotFound` if zero rows
- [x] 2.5 Remove the schema-wide `SQL_LIST_INDEXES` and `SQL_LIST_TRIGGERS` and their helpers (`list_indexes`, `list_triggers`) — superseded by per-table variants
- [x] 2.6 Remove `pub async fn list_objects(...)` and the `SchemaObjects` struct; update existing unit tests in `schema.rs` (`trigger_timing_decodes`, `trigger_events_decodes`, `table_kind_maps`, `type_kind_maps`, `permission_denied_detected`) — these stay; remove any test referencing `list_objects` if present

## 3. Backend — list_relations command

- [x] 3.1 In `schema_commands.rs`, add `pub const RELATIONS_TIMEOUT: Duration = Duration::from_secs(10);`
- [x] 3.2 Add `#[tauri::command] postgres_list_relations(pools, id, schema_name) -> AppResult<RelationsResult>` that acquires the client, captures the cancel token, runs `timeout(RELATIONS_TIMEOUT, list_relations(...))`, on timeout fires the cancel and returns `AppError::postgres_with_code("57014", ...)`, on success returns the `RelationsResult` directly
- [x] 3.3 Add `tracing::info!` logging on entry and on exit (timing in ms, table/view/matview counts) following the pattern of the existing `postgres_list_objects`

## 4. Backend — list_structure command (with partial-degradation)

- [x] 4.1 Add `pub const STRUCTURE_TOTAL_TIMEOUT: Duration = Duration::from_secs(10);` and `pub const PER_QUERY_TIMEOUT: Duration = Duration::from_secs(8);`
- [x] 4.2 Add `#[tauri::command] postgres_list_structure(pools, id, schema_name) -> AppResult<StructureResult>` that acquires the client and runs `tokio::join!` over `timeout(PER_QUERY_TIMEOUT, try_kind("functions", ..., || list_functions(...)))`, the same for `types`, and the same for `extensions`, all wrapped in an outer `timeout(STRUCTURE_TOTAL_TIMEOUT, ...)`
- [x] 4.3 Implement the result aggregator: each sub-result is `Result<AppResult<Vec<...>>, Elapsed>`; collapse the two layers into either `Some(payload)` (success, including empty from permission-denied) or `None` + a `KindFailure` push to `failures`; per-query elapsed becomes a 57014 failure; non-timeout `AppError` becomes a typed failure with the corresponding code/message
- [x] 4.4 If the OUTER total timeout fires before all sub-queries complete, fire the cancel token, drop the client, and return a `StructureResult` whose unfinished kinds appear in `failures` with code `"57014"`. This requires `tokio::select!` between the outer timeout and the inner `tokio::join!`; on outer timeout, mark not-yet-completed kinds as failed
- [x] 4.5 Add `tracing::info!` on success including `failures.len()`; add `tracing::warn!` for each failure entry

## 5. Backend — list_table_extras command

- [x] 5.1 Add `#[tauri::command] postgres_list_table_extras(pools, id, schema_name, relation) -> AppResult<TableExtrasResult>` mirroring §4 with two sub-queries instead of three (`list_table_indexes`, `list_table_triggers`)
- [x] 5.2 Use the same `STRUCTURE_TOTAL_TIMEOUT` (10s) and `PER_QUERY_TIMEOUT` (8s) constants
- [x] 5.3 Reuse the result-aggregator helper from §4 (parameterize over kind names) so the partial-degradation logic is not duplicated

## 6. Backend — get_function_signature command

- [x] 6.1 Add `pub const FUNCTION_SIG_TIMEOUT: Duration = Duration::from_secs(5);`
- [x] 6.2 Add `#[tauri::command] postgres_get_function_signature(pools, id, schema_name, name, oid: i64) -> AppResult<FunctionSignature>` that acquires the client, runs `timeout(FUNCTION_SIG_TIMEOUT, get_function_signature(...))`, returns `AppError::NotFound` if the catalog returns zero rows, returns `AppError::postgres_with_code("57014", ...)` on timeout
- [x] 6.3 Add `tracing::info!` on entry and exit

## 7. Backend — wire commands and remove old

- [x] 7.1 In `src-tauri/src/modules/postgres/commands.rs` (or wherever `tauri::generate_handler!` is composed), add the four new commands and remove `postgres_list_objects`
- [x] 7.2 In `src-tauri/src/lib.rs`, update the global `tauri::generate_handler!` invocation to reflect the new set
- [x] 7.3 Verify `cargo build` succeeds on the Rust side; fix any leftover references to `list_objects` / `SchemaObjects`

## 8. Backend — unit tests

- [x] 8.1 Add a unit test for `map_failure` covering `AppError::Postgres { code: Some("57014") }`, `AppError::Postgres { code: None }`, `AppError::Validation`, `AppError::Internal`
- [x] 8.2 Add a unit test that simulates a partial-degradation result: feed the aggregator three results (one Ok, one Err timeout, one Ok-empty-from-permission-denied) and assert the resulting `StructureResult` has `failures.len() == 1` with kind `"functions"` (or whichever) and the other kinds are `Some(...)`
- [ ] 8.3 Update the live tests gated behind `live-pg-tests` to call each of the four new commands instead of `postgres_list_objects`

## 9. Frontend — types and IPC layer

- [x] 9.1 In `src/modules/postgres/schema/types.ts`, replace `SchemaObjects` with `RelationsResult`, `StructureResult`, `TableExtrasResult`, `FunctionSignature`, `KindFailure`. Remove `args_signature` / `return_type` from `FunctionInfo`; add `oid: number`
- [x] 9.2 In `src/modules/postgres/schema/api.ts`, replace `schemaApi.listObjects(...)` with `schemaApi.listRelations(...)`, `schemaApi.listStructure(...)`, `schemaApi.listTableExtras(connectionId, schema, relation)`, `schemaApi.getFunctionSignature(connectionId, schema, name, oid)`
- [x] 9.3 Confirm the SQLSTATE 57014 helper in `src/modules/postgres/errors.ts` already covers all four commands (it should — it inspects `AppError.kind === "Postgres" && AppError.postgres?.code`); add a unit-style test if missing

## 10. Frontend — useSchemaTree reducer rewrite

- [x] 10.1 Replace `objects: Map<string, ObjectState>` with `objects: Map<string, GroupCacheEntry>` where `GroupCacheEntry { relations: GroupState<RelationsResult>, structure: GroupState<StructureResult>, tableExtras: Map<string, GroupState<TableExtrasResult>> }`
- [x] 10.2 Update the action union: replace `objectsLoading/objectsLoaded/objectsFailed/objectsRetrying` with `relationsLoading/relationsLoaded/relationsFailed/relationsRetrying`, `structureLoading/structureLoaded/structureFailed`, `tableExtrasLoading/tableExtrasLoaded/tableExtrasFailed` (each carries `schema`, plus `relation` for table-extras actions)
- [x] 10.3 Implement `runFetchRelations(schema, isRetry)`, `runFetchStructure(schema)`, `runFetchTableExtras(schema, relation)` mirroring the current `runFetch` pattern; **only** `runFetchRelations` keeps the auto-retry-on-57014 behavior
- [x] 10.4 Public hook API: `getRelations(schema)`, `getRelationsState(schema)`, `getRelationsError(schema)`, plus equivalents for `Structure` and `TableExtras(schema, relation)`; keep `invalidate()` (clears the entire connection cache) and add `invalidateGroup(schema, group)` and `invalidateTableExtras(schema, relation)`
- [x] 10.5 The lazy hooks (`getStructure`, `getTableExtras`) MUST NOT auto-trigger fetches on first read; they expose explicit `loadStructure(schema)` and `loadTableExtras(schema, relation)` setters that the tree calls in its `onExpand` handler
- [x] 10.6 The eager hook `getRelations` keeps the current behavior of triggering a fetch via `queueMicrotask` on first idle read, since visibility implies eager load

## 11. Frontend — SchemaTree.tsx integration

- [x] 11.1 Update the eager `useEffect` that loops over `visibility.visible` to call `tree.getRelations(name)` instead of `tree.getObjects(name)`
- [x] 11.2 Update `buildSchemaNode` to consume `tree.getRelations(s.name)` for the `Data` group and to render the `Structure` group as a placeholder node `{ id: "schema:X/structure", label: "Structure", placeholder: "(expand to load)" }` when the structure cache slot is `idle`
- [x] 11.3 Pass an `onToggle(node, expanded)` handler to `SidebarTree` that, on first expansion of a Structure group node, calls `tree.loadStructure(schema)`; on first expansion of a table node, calls `tree.loadTableExtras(schema, relation)`
- [x] 11.4 Render the inner contents of the `Structure` group based on its `GroupState`: `loading` → spinner placeholder; `loaded` with empty `failures` → mixed alphabetical list of functions/types/extensions; `loaded` with non-empty `failures` → render successful kinds + per-kind "K failed (Retry)" placeholder; `error` → "Failed to load. (Retry)" placeholder spanning the group
- [x] 11.5 Render the inner contents of each table's `Indexes`/`Triggers` sub-groups based on its `tableExtras` GroupState in the same shape (loading / partial / loaded / error)
- [x] 11.6 Wire the inline `Retry` buttons: per-group retries call `tree.loadStructure(schema)` (re-running all three sub-queries; the cache slot is replaced); per-table retries call `tree.loadTableExtras(schema, relation)`; the relations group's manual retry calls `tree.retryRelations(schema)` (delegates to the same auto-retry-aware flow)

## 12. Frontend — function overload UI

- [x] 12.1 Detect overloads in the rendered structure list (group functions by `name`); when there are multiple entries, render each as `<name>` plus a small text badge showing the count or a sequence index (`#1`, `#2`)
- [x] 12.2 Function tree node `id` becomes `schema:X/structure/function/<oid>` (was probably `<name>` before) so duplicates are distinguishable in the SidebarTree's expansion state
- [x] 12.3 On node activation (open object placeholder tab), include the `oid` in the tab payload alongside `{ schema, kind: "function", name }`; the placeholder tab caption shows the bare name; signature is fetched async via `schemaApi.getFunctionSignature(...)` and displayed when ready
- [x] 12.4 (Optional, can defer) Tooltip on hover of a function node fetches and shows the signature; debounce / cache so a rapid hover doesn't fire multiple IPCs

## 13. Frontend — search compatibility

- [x] 13.1 Update `filterTree` (in `SchemaTree.tsx`) so it walks the new lazy children correctly: structure/table-extras nodes that haven't been loaded yet are simply not searchable (the placeholder node is filtered out by name unless the search string matches "Structure" / "Indexes" / "Triggers")
- [x] 13.2 The search-empty-state indicator currently mentions "N schemas have not been loaded yet". Update its copy to also call out unloaded `Structure` groups and unloaded tables (so the user knows search results may be incomplete until they expand)

## 14. Frontend — invalidation glue

- [x] 14.1 The existing `subscribeSchemaEvent` listener on `invalidate { connectionId }` continues to call `dispatch({ type: "invalidate" })`, which now wipes the new map shape; verify the reducer's `invalidate` handler resets all three slots and the per-table map
- [x] 14.2 The existing `postgres:active-changed` listener continues to call `dispatch({ type: "invalidate" })` — no change required beyond §14.1

## 15. Manual QA against the four problematic schemas

- [ ] 15.1 Connect to the user's Postgres and confirm all 11 visible schemas render their `Data` group within ~2 seconds (no spinner stuck)
- [ ] 15.2 Expand each of the 4 previously-problematic schemas' `Structure` group: confirm partial-failure rendering (some kinds load, others show inline failure with retry) when the heavy query is slow
- [ ] 15.3 Expand a table that has many indexes/triggers: confirm `list_table_extras` returns within ~1s for the typical case; confirm partial degradation if either sub-query is slow
- [ ] 15.4 Activate a function with overloads: confirm two distinct nodes are rendered, both activatable, signature loads async in the placeholder tab
- [ ] 15.5 Test `Schema: Refresh` palette command: confirm the entire connection cache is wiped and re-fetched on next expansion
- [ ] 15.6 Test inline `Retry` buttons: confirm per-group / per-kind retry re-fetches only that scope and replaces the cache slot

## 16. Cleanup and final verification

- [x] 16.1 Grep the repo for any remaining references to `postgres_list_objects` / `listObjects` / `SchemaObjects` and clean them up (TypeScript types, Rust types, comments)
- [x] 16.2 Run `cargo test -p argus` for the Rust unit tests; run `pnpm test` for any frontend tests; fix any breakage from the type renames
- [x] 16.3 Run `cargo clippy -- -D warnings` and `pnpm lint` to confirm no new warnings
- [x] 16.4 Update the existing module-level rustdoc comments in `schema.rs` and `schema_commands.rs` that still reference the bulk command pattern
- [ ] 16.5 Visual check: open `design/preview.html` if relevant or screenshot the sidebar, confirm DESIGN.md tokens (Geist fonts, accent color, hairlines, spacing) are still correctly applied to the new placeholder/retry UI
