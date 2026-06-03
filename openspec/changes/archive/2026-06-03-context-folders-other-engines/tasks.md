## 1. Refactor: pool-only inner functions

- [x] 1.1 MySQL: extract `pub async fn list_schemas_for_pool(pool: &MySqlPool) -> AppResult<Vec<SchemaInfo>>` from `mysql_list_schemas` in `src-tauri/src/modules/mysql/schema_commands.rs`; rewrite the command to call it (keep activity-log + telemetry in the wrapper)
- [x] 1.2 MySQL: extract `list_relations_for_pool(pool: &MySqlPool, schema: &str)` from `mysql_list_relations`
- [x] 1.3 MySQL: extract `list_structure_for_pool(pool: &MySqlPool, schema: &str, relation: &str)` from `mysql_list_structure`
- [x] 1.4 MSSQL: extract `list_schemas_for_pool` from `mssql_list_schemas` in `src-tauri/src/modules/mssql/schema_commands.rs`
- [x] 1.5 MSSQL: extract `list_relations_for_pool(pool, schema)` from `mssql_list_relations`
- [x] 1.6 MSSQL: extract `list_structure_for_pool(pool, schema, relation)` from `mssql_list_structure`
- [x] 1.7 Dynamo: confirm `describe_table(client, name)` and `list_tables`-style enumerator are already pool-only (they are); re-export where needed
- [x] 1.8 Run `cargo test --lib platform mysql mssql dynamo` after each engine's refactor to confirm zero regression

## 2. IntrospectorPools + adapter dispatch

- [x] 2.1 Add `pub struct IntrospectorPools<'a>` to `src-tauri/src/modules/context/introspect_adapters.rs` with fields `pg`, `mysql`, `mssql`, `dynamo`
- [x] 2.2 Change `pub fn introspector_for<'a>(engine, pools: IntrospectorPools<'a>) -> Box<dyn IntrospectForContext + 'a>`
- [x] 2.3 Update existing `PostgresIntrospector` construction to take `pools.pg`
- [x] 2.4 Update `context_sync_schema` Tauri command signature to take `pg`, `mysql`, `mssql`, `dynamo` registries as `State<>` parameters; build the `IntrospectorPools` and dispatch
- [x] 2.5 Update `lib.rs` (the command is already registered; just rebuild)

## 3. MySQL introspector adapter

- [x] 3.1 Implement `MysqlIntrospector<'a> { pool: &'a MysqlPoolRegistry }` with `IntrospectForContext` impl
- [x] 3.2 `introspect_for_context(conn_id)`: acquire pool → call `list_schemas_for_pool` (filter system schemas: `information_schema`, `mysql`, `performance_schema`, `sys`) → per schema call `list_relations_for_pool` → per relation call `list_structure_for_pool` → map to `ObjectShape { kind: "table"|"view", schema: Some, name, primary_key: PrimaryKey.columns, columns: TableStructureColumn → { name, ty: data_type } }`
- [x] 3.3 Per-relation errors logged via `tracing::warn!` and skipped (do not abort the whole sync)
- [x] 3.4 Wire into `introspector_for` dispatch
- [x] 3.5 Add a `cargo check --tests` regression check (no live-DB test possible)

## 4. MSSQL introspector adapter

- [x] 4.1 Implement `MssqlIntrospector<'a>` analogously, using `list_schemas_for_pool` / `list_relations_for_pool` / `list_structure_for_pool`
- [x] 4.2 System-schema filter: exclude `sys`, `INFORMATION_SCHEMA`, `db_*`, `guest`
- [x] 4.3 Wire into dispatcher

## 5. Dynamo introspector adapter

- [x] 5.1 Implement `DynamoIntrospector<'a> { registry: &'a DynamoClientRegistry }`
- [x] 5.2 Acquire client → call the existing pager to enumerate table names → per table call `describe_table` → map to `ObjectShape { kind: "dynamo_table", schema: None, name, primary_key: key_schema sorted [HASH, RANGE], columns: attribute_definitions → { name, ty: attribute_type } }`
- [x] 5.3 Wire into dispatcher

## 6. Shared frontend helpers

- [x] 6.1 Extend `src/modules/context/components/substituteParams.ts`: add `substituteMssqlParams(body, values)` that replaces `\b@name\b` with the same escaping rules as Postgres; add `substituteDynamoParams(body, values)` that replaces `\b\$name\b` (escaped `$` in the regex) with PartiQL literal syntax (strings quoted, numbers raw, booleans raw, null as `NULL`)
- [x] 6.2 Add unit tests for both new helpers (mirror the 6 existing Postgres tests; include `null` handling for Dynamo)
- [x] 6.3 Update `src/modules/context/openContextQuery.ts` to dispatch on `engine`: each engine routes to its own `openQueryTab` (Postgres/MySQL/MSSQL SQL editor; Dynamo: see §9)

## 7. MySQL schema-browser integration

- [x] 7.1 In `src/modules/mysql/schema/SchemaTree.tsx`: read `context_path` via `useConnections()`, call `useContextObjects(connectionId, contextPath)`, build `Map<"schema.name", ObjectListItem>`, compose `renderBadge` to include `<DocBadge deletedInDb={item.deleted_in_db} />` for table/view nodes
- [x] 7.2 Render `<ContextFolderBanner ... />` above the tree
- [x] 7.3 In `src/modules/mysql/structure/SubtabHeader.tsx` (verify exact filename): extend `Subtab` union with `"docs"`, add `{ id: "docs", label: "Docs" }` to TABS, accept `visibleTabs?: Subtab[]` prop
- [x] 7.4 In the MySQL detail-view orchestrator (likely `src/modules/mysql/data/TableViewerTab.tsx`): compute `docsAvailable`, pass `visibleTabs`, render `<DocsSubtab>` when active, pass `columnNotes` to `StructureSubtab`
- [x] 7.5 Snap-back to `"data"` if active subtab is `"docs"` and the user navigates to an undocumented relation
- [x] 7.6 Tests: extend the existing MySQL data-view test (mirror Postgres `TableViewerTab.test.tsx` mocks for `useConnections`, `useContextObjects`, `useContextObject`)

## 8. MSSQL schema-browser integration

- [x] 8.1 In `src/modules/mssql/schema/SchemaTree.tsx`: same wiring as §7.1 / §7.2
- [x] 8.2 In `src/modules/mssql/structure/SubtabHeader.tsx` (verify): same extension as §7.3
- [x] 8.3 In `src/modules/mssql/data/TableViewerTab.tsx`: same orchestrator wiring as §7.4 / §7.5
- [x] 8.4 Tests as §7.6

## 9. Dynamo schema-browser integration

- [x] 9.1 In `src/modules/dynamo/tables/DynamoConnectionSubtree.tsx`: read `context_path`, call `useContextObjects` keyed by table name (`identity = name`), render `<DocBadge>` after table-leaf labels
- [x] 9.2 Render `<ContextFolderBanner>` above the subtree
- [x] 9.3 Investigate Dynamo's data-view inspector layout (`src/modules/dynamo/data-view/Inspector.tsx` or equivalent); identify the correct insertion point for a collapsible "Docs" panel below the existing table metadata block
- [x] 9.4 Create `src/modules/context/components/DocsPanel.tsx` — a thin collapsible wrapper around `<DocsSubtab>` for use where there is no `SubtabHeader` (Dynamo). Header label "Docs", default open when doc exists.
- [x] 9.5 Mount `<DocsPanel connectionId contextPath identity={tableName} />` in the Dynamo inspector
- [x] 9.6 Decorate the Dynamo inspector's attribute-definitions rows with `human.column_notes[name]` annotations
- [x] 9.7 Tests: `DocsPanel.test.tsx` (renders only when doc exists, toggles open/closed) and a Dynamo subtree test extension

## 10. Context Queries sidebar branch — per engine

- [x] 10.1 In `src/platform/shell/ConnectionRow.tsx`: under the MySQL active branch, render `<ContextFolderBanner>` and `<ContextQueriesBranch engine="mysql" ...>` below `<MysqlSchemaTree>`; wire `onActivate` to a new `openContextQuery(tabs, connId, name, "mysql", q)` call
- [x] 10.2 Same for MSSQL active branch (`engine="mssql"`)
- [x] 10.3 Same for Dynamo active branch (`engine="dynamo"`) — placement below `<DynamoConnectionSubtree>`
- [x] 10.4 Update `openContextQuery.ts`: for `mysql` open a MySQL SQL tab (analogous to `openQueryTab` for Postgres — likely `src/modules/mysql/sql/openMysqlQueryTab.ts`); for `mssql` analogous; for `dynamo` see §11
- [x] 10.5 In each engine's `QueryTab`-equivalent file, accept the same optional `contextQuery: { name, params }` payload and render `<ParamStrip>` above the editor (mirror what Postgres' `QueryTab.tsx` already does — extract `useContextQueryTabState` shared hook if useful, otherwise duplicate per engine)
- [x] 10.6 Wire each engine's substitution helper: MySQL uses `substitutePostgresParams`, MSSQL uses `substituteMssqlParams`, Dynamo uses `substituteDynamoParams`

## 11. Dynamo prefab queries — investigation + fallback

- [x] 11.1 Identify whether a Dynamo "open PartiQL editor with body" entrypoint exists in the codebase (grep `src/modules/dynamo/` for query-builder / raw-input components)
- [ ] 11.2 If yes: route Dynamo `openContextQuery` to that entrypoint with the body + param strip wired <!-- N/A: no native PartiQL editor in repo; §11.3 clipboard fallback shipped instead -->
- [x] 11.3 If no: ship Dynamo Context Queries as **copy-to-clipboard only** in v1 — the row's activate action substitutes via `substituteDynamoParams` and writes the result to the clipboard with a toast confirmation. Add follow-up task to build a real PartiQL editor.
- [x] 11.4 Document the chosen path in the change report

## 12. Tests

- [x] 12.1 Add a Rust unit test asserting `introspector_for(EngineKind::Mysql, ...)` returns a non-`NotImplemented` adapter; same for MSSQL and Dynamo
- [x] 12.2 Add a Rust unit test that `context_sync_schema` for an unknown kind (e.g. `cloudwatch`) still returns `AppError::Internal`
- [x] 12.3 `substituteMssqlParams` tests: 5 cases mirroring Postgres + `@name` boundary cases (`@@variable` not replaced)
- [x] 12.4 `substituteDynamoParams` tests: 5 cases including `null → NULL`, string with single quote
- [x] 12.5 MySQL/MSSQL TableViewerTab tests: badge/Docs/columnNotes wiring
- [x] 12.6 Dynamo DocsPanel test + subtree badge test
- [x] 12.7 Run full `pnpm test:run` + `cargo test --lib` — no regressions

## 13. Documentation

- [x] 13.1 Update `README.md` "Context folders" section: change "Postgres ships with full sync support; MySQL, MSSQL, DynamoDB and CloudWatch are on the roadmap" → "Postgres, MySQL, MSSQL, and DynamoDB ship with full sync support; CloudWatch is on the roadmap"
- [x] 13.2 Extend `docs/context-folder-example/` with `mysql/`, `mssql/`, `dynamo/` example subtrees so the example covers all four engines (one minimal object doc + one prefab query each)
- [x] 13.3 Update `CLAUDE.md` "Context folders" mention if it claims Postgres-only
- [x] 13.4 Verify visual additions on each engine conform to `DESIGN.md`

## 14. End-to-end QA

Manual; cannot be auto-completed.

- [ ] 14.1 MySQL: link folder, run Sync schema, verify `mysql/<schema>/<table>.md` files appear and re-sync preserves `human:` + body
- [ ] 14.2 MSSQL: same, with `mssql/<schema>/<table>.md`
- [ ] 14.3 Dynamo: same, with `dynamo/tables/<name>.md`; verify `system.primary_key` lists `[partition_key, sort_key?]`
- [ ] 14.4 Per engine: verify `📄` badge appears, Docs subtab/panel renders, column notes decorate, banner appears when folder removed
- [ ] 14.5 Per engine: verify Context Queries branch lists `.sql` (MySQL/MSSQL) / `.partiql` (Dynamo) and the prefab tab opens with param strip
- [ ] 14.6 Run `pnpm test:run` + `cargo test --lib` once more; no new failures vs baseline
