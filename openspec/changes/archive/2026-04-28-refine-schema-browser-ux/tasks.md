## 1. Backend types: drop sequences

- [x] 1.1 Delete `SequenceInfo` from `src-tauri/src/modules/postgres/schema_types.rs`
- [x] 1.2 Remove the `sequences: Vec<SequenceInfo>` field from `SchemaObjects`
- [x] 1.3 Remove all references to sequences in `src-tauri/src/modules/postgres/schema.rs` (delete `SQL_LIST_SEQUENCES`, `list_sequences`, the `try_kind` call site, the `tracing::debug!` line that mentions sequences) and from any tests in that file

## 2. Backend SQL: UNION-ALL data query

- [x] 2.1 In `schema.rs`, replace `SQL_LIST_TABLES`, `SQL_LIST_VIEWS`, `SQL_LIST_MATVIEWS` with a single `SQL_LIST_DATA` matching the SQL in `design.md` (relkind in `r,p,f,v,m`, ordered by `relname`)
- [x] 2.2 Implement `populate_data(rows, &mut SchemaObjects)` that walks the result and pushes each row into `tables` (with the right `TableKind`), `views`, or `materialized_views` based on the `relkind` text column
- [x] 2.3 Delete `list_tables`, `list_views_with_sql`, `list_views`, `list_materialized_views` (replaced by `populate_data`)
- [x] 2.4 Update the existing test `table_kind_maps` to keep covering the regular/partitioned/foreign mapping (the helper `map_table_kind` still applies)

## 3. Backend pipelining and `list_objects` rewrite

- [x] 3.1 Rewrite `pub async fn list_objects(client, schema)` to: (a) fire `client.query(SQL_LIST_DATA, &[&schema])` and the 5 structure helpers (`list_functions`, `list_types`, `list_extensions`, `list_indexes`, `list_triggers`) inside a single `tokio::try_join!`; (b) call `populate_data` on the data rows; (c) return a populated `SchemaObjects`
- [x] 3.2 Make sure the permission-denied resilience still works — wrap each structure helper in `try_kind` before `tokio::try_join!`. The data query stays unwrapped: on permission denied at the data layer, the whole call surfaces the error (the user can't browse a schema they can't see)
- [x] 3.3 Update the `tracing::debug!` log to print the new counts shape (no sequences)

## 4. Backend timeout + real cancellation

- [x] 4.1 In `pool.rs`, add `pub sslmode: SslMode` to `ActivePool` and populate it on `connect`
- [x] 4.2 Add `pub(crate) async fn sslmode_for(&self, id: &Uuid) -> AppResult<SslMode>` on `PgPoolRegistry` (mirrors `acquire`'s NotFound behavior)
- [x] 4.3 In `schema_commands.rs`, wrap the `schema::with_client(...)` body in `tokio::time::timeout(Duration::from_secs(15), ...)`
- [x] 4.4 Capture `let cancel_token = client.cancel_token();` immediately after `acquire` and BEFORE starting the work, so it's available even when the timeout fires
- [x] 4.5 On timeout: invoke `cancel_token.cancel_query(connector).await` where `connector` is built from the `sslmode_for(id)` value (using `client_config_for(sslmode)` + `MakeRustlsConnect::new(...)`, falling back to `NoTls` for `Disable`); ignore the result; then return `AppError::postgres_with_code("57014", "schema load timed out (15s)")`
- [x] 4.6 Add a `tracing::warn!` if `cancel_query` itself errored
- [ ] 4.7 Manual smoke test (deferred to section 9): a schema known to be slow times out at ~15s and a follow-up `pg_stat_activity` shows the cancelled query gone

## 5. Frontend types

- [x] 5.1 In `src/modules/postgres/schema/types.ts`: drop `SequenceInfo`; drop the `sequences: SequenceInfo[]` field on `SchemaObjects`
- [x] 5.2 In `src/modules/postgres/index.ts` barrel: drop `SequenceInfo` from the type re-exports

## 6. useSchemaTree state machine

- [x] 6.1 Extend `ObjectState` union with `{ state: "retrying"; previous?: SchemaObjects }` so the UI can keep showing stale-but-known counts during the retry
- [x] 6.2 Add a `RETRYABLE_TIMEOUT_CODE = "57014"` constant
- [x] 6.3 Update `fetchObjects(schema)` to: on first failure, if the AppError is `Postgres` with `postgres.code === "57014"`, dispatch `objectsRetrying` and recursively call a single retry; otherwise dispatch `objectsFailed` as today
- [x] 6.4 Add `retrySchema(name)` to the hook's returned API; it dispatches `objectsLoading` (clearing any prior error/retry) and re-runs the same fetch flow (which itself can auto-retry once on 57014)
- [x] 6.5 Add reducer cases for `objectsRetrying` (transitions any state to `retrying`) and update `objectsLoaded`/`objectsFailed` to handle the `retrying` predecessor
- [x] 6.6 Memoize the new `retrySchema` in the returned object alongside `invalidate` / `invalidateSchema`

## 7. SchemaTree UI: two-group flat layout

- [x] 7.1 In `SchemaTree.tsx`, remove `buildGroupNode("tables", …)`, `buildGroupNode("views", …)`, `buildGroupNode("materialized_views", …)`, `buildGroupNode("functions", …)`, `buildGroupNode("types", …)`, `buildGroupNode("extensions", …)`, and `buildGroupNode("sequences", …)` — they are replaced by a `buildDataGroup` and `buildStructureGroup` pair
- [x] 7.2 Implement `buildDataGroup(schema, payload)` that merges tables (regular, partitioned, foreign), views, and materialized views into a single alphabetically-sorted `TreeNode[]`. Each node carries a `LeafData` payload with its `objectKind`. Tables that have indexes/triggers keep their existing `Indexes`/`Triggers` sub-groups as nested children
- [x] 7.3 Implement `buildStructureGroup(schema, payload)` that merges functions, types, and extensions into a single alphabetically-sorted `TreeNode[]`. No nesting; functions keep their `name(args_signature)` label
- [x] 7.4 Update the schema node to expose only `[Data?, Structure?]` as children (omit the group entirely when empty); use the existing `GroupKind`/`GroupIcon` mapping by extending it with `data` and `structure` keys (or replacing with a small ad-hoc icon picker — implementer's call)
- [x] 7.5 Render badges: `partitioned` (text) and `FDW` (text) for partitioned and foreign tables. Icon stays the regular-table icon
- [x] 7.6 Add small color tints (CSS custom properties on `SchemaTree.module.css`) for view, mat-view, function, type, extension; apply via inline `style={{ color: var(--…) }}` in `renderIcon`. Default for tables is the existing `--text-muted`
- [x] 7.7 Remove all sequence handling from `SchemaTree.tsx` and `objectIcons.tsx` (delete `LeafKind: "sequence"` and `GroupKind: "sequences"`)

## 8. SchemaTree UI: retrying + manual retry

- [x] 8.1 In the schema-row rendering of `SchemaTree.tsx`, when the schema's state is `loading` show a small spinner glyph next to the schema name in the `renderBadge` slot
- [x] 8.2 When state is `retrying`, show the same spinner with the text "(retrying)" — visible in the schema row (not just the placeholder child)
- [x] 8.3 When state is `error`, render a `↻` button via the badge slot that calls `tree.retrySchema(name)` on click. Use Lucide `RotateCw`. Stop event propagation so the click doesn't toggle the schema's expansion
- [x] 8.4 The error placeholder child (currently "Failed to load — open to retry") becomes "{message}" — the user has the explicit Retry button in the row now
- [x] 8.5 Make sure the `forceExpanded` set used by search filtering still works: schemas in `error` state remain expandable so the user can read the error placeholder

## 9. Verification

- [x] 9.1 `cargo clippy --all-targets -- -D warnings` clean
- [x] 9.2 `cargo test --lib` — all existing tests still pass; the table-kind/type-kind decoders unaffected
- [x] 9.3 `pnpm typecheck` clean
- [x] 9.4 `pnpm lint` no new errors (warnings consistent with repo)
- [x] 9.5 `pnpm build` succeeds
- [ ] 9.6 Manual: a small schema (3–5 objects in each group) renders as expected — Data + Structure groups, alphabetical, sequences absent, partitioned/FDW badges visible if any
- [ ] 9.7 Manual: a fast schema (<15 s) loads on first try — no `retrying` flicker
- [ ] 9.8 Manual: a slow schema reproduces the timeout flow — `retrying` indicator appears, then either succeeds or shows the Retry button
- [ ] 9.9 Manual: `pg_stat_activity` confirms that on backend timeout, the long-running query disappears within ~1 s of the cancel (rather than still running)
- [ ] 9.10 Manual: clicking the Retry button after a final error re-enters the loading flow and (if the schema now responds) displays normally
