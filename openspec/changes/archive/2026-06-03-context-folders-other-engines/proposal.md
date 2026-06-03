## Why

`add-connection-context-folders` shipped end-to-end for Postgres only. The remaining engines (MySQL/MariaDB, MS SQL Server, DynamoDB) can already *link* a folder and read it (the cross-engine parser, registry and watcher are engine-agnostic), but they cannot **sync** schemas (the adapter returns `Internal("not yet wired for kind '<engine>'")`), and their schema browsers / connection sidebars do not surface the `📄` badge, the Docs subtab, the column-note decorations, or the Context Queries sidebar branch. The feature is therefore visible only to half the supported sources, which is confusing in a multi-engine tool. This change closes the gap by replicating the Postgres wiring across MySQL, MSSQL, and Dynamo. CloudWatch stays out of scope (no `cloudwatch/` module exists in the codebase yet).

## What Changes

- **Sync adapters** for MySQL, MSSQL, and Dynamo: replace the `NotImplementedIntrospector` arms in `src-tauri/src/modules/context/introspect_adapters.rs` with real implementations that delegate to each engine's existing introspection code, returning normalised `ObjectShape` values.
- **Per-engine refactor (small)**: extract pool-only inner functions from `mysql_list_schemas`/`mysql_list_relations`/`mysql_list_structure` (and equivalents on MSSQL/Dynamo) so the adapters can call them without going through the Tauri-state boundary.
- **`context_sync_schema` command** gains the missing engine pool registries as Tauri `State<>` parameters and dispatches to the right introspector. Behaviour and result shape (`SyncReport`) are unchanged.
- **Schema-tree integration** (MySQL/MSSQL/Dynamo): each `SchemaTree` (or Dynamo's `DynamoConnectionSubtree`) renders the existing `DocBadge` after node labels for documented relations and shows the existing `ContextFolderBanner` when the folder is `Unavailable`.
- **Docs subtab** (MySQL/MSSQL): each engine's detail-view orchestrator (`mysql/data/TableViewerTab.tsx`, `mssql/data/TableViewerTab.tsx`) gets a `docs` entry added to its `SubtabHeader` and renders the existing `DocsSubtab` component, plus passes `columnNotes` to the structure subtab.
- **Docs panel** (Dynamo): Dynamo has no `SubtabHeader` (its detail view is flatter); the `DocsSubtab` is rendered as a collapsible panel inside the existing Dynamo `DataViewTab` inspector area. Column notes are decorated onto attribute metadata.
- **Context Queries sidebar branch** (MySQL/MSSQL/Dynamo): each engine's branch in `src/platform/shell/ConnectionRow.tsx` renders the existing `ContextQueriesBranch` below the schema/tables tree. The branch's `openContextQuery` helper learns to open the right kind of editor tab per engine (MySQL/MSSQL SQL editor, Dynamo PartiQL editor).
- **Client-side param substitution** is extended with engine-specific escaping (MySQL same as Postgres, MSSQL uses `@name` placeholders, Dynamo PartiQL uses `?` positional with values array passed at run-time).
- Existing Postgres behaviour is **unchanged**; no Postgres files are touched.

## Capabilities

### New Capabilities

(none — this change extends existing capabilities to additional engines.)

### Modified Capabilities

- `connection-context-folders`: schema-sync now supports MySQL, MSSQL, and Dynamo (previously Postgres-only). The `IntrospectForContext` adapter dispatch and the `context_sync_schema` command signature are updated.
- `context-objects-browser`: requirements that name "the schema browser" become true across MySQL, MSSQL, and Dynamo (previously only Postgres satisfied them).
- `context-queries-runner`: requirements that name "the connection's editor" become true for MySQL (SQL editor), MSSQL (SQL editor with `@name` substitution), and Dynamo (PartiQL editor with `$name` substitution).
- `mysql-schema-browser`, `mssql-schema-browser`, `dynamo-table-browser`: tree nodes matching a documented object render the existing `DocBadge`; selecting a node exposes the `DocsSubtab` (MySQL/MSSQL inline, Dynamo as a panel); column notes from `human.column_notes` decorate the column/attribute lists.

## Impact

- **Backend (Rust)**: `src-tauri/src/modules/context/introspect_adapters.rs` gains `MysqlIntrospector`, `MssqlIntrospector`, `DynamoIntrospector`. New pool-only helper functions in `src-tauri/src/modules/{mysql,mssql,dynamo}/...` exposing the introspection logic that the existing Tauri commands wrap. `context_sync_schema` command signature gains `mysql: State<'_, MysqlPoolRegistry>`, `mssql: State<'_, MssqlPoolRegistry>`, `dynamo: State<'_, DynamoClientRegistry>`.
- **Frontend (TS)**: `src/modules/{mysql,mssql,dynamo}/...` get the same `DocBadge` + `DocsSubtab` + `columnNotes` wiring already in Postgres. `ContextQueriesBranch` is rendered for each engine in `ConnectionRow.tsx`. `openContextQuery.ts` learns the per-engine routing. `substituteParams.ts` gains `substituteMssqlParams` and `substituteDynamoParams` helpers.
- **Storage / config**: no schema migration, no new settings keys.
- **Dependencies**: none added.
- **User-visible behaviour**: linking a folder, syncing, browsing docs, and running prefab queries all work uniformly across the four engines (CloudWatch excluded).
- **Out of scope (v1)**: CloudWatch adapter (module doesn't exist yet); `postgres_run_sql_named` and equivalent auto-run wiring (already deferred in the previous change as task 11.5 — same deferral applies here); markdown renderer in `DocsSubtab` (still `<pre>` placeholder until `react-markdown` or equivalent is added).
