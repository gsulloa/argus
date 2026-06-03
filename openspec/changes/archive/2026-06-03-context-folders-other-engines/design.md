## Context

`add-connection-context-folders` left three large categories of work as explicit Postgres-only deferrals (tasks 6.2/6.3, 10.* nota, 11.* nota in the prior change's `tasks.md`). The architectural pieces are already engine-agnostic:

- Parser, registry, watcher, sync executor, AI payload, file-format spec — all share one cross-engine implementation.
- `IntrospectForContext` trait + `introspector_for(engine, ...)` dispatcher.
- Shared frontend components: `DocBadge`, `DocsSubtab`, `ContextFolderBanner`, `ContextQueriesBranch`, `ParamStrip`, `substitutePostgresParams`, `openContextQuery`.
- Connection form's `ContextFolderRow` is already engine-agnostic and is injected in all four `ConnectionForm.tsx`.

What's missing is purely the per-engine wiring of those pieces. That wiring is mechanical but spans 6 files per engine, and the engines differ in three concrete ways that drive the design.

### How the three engines differ from Postgres

1. **MySQL** is the closest neighbour: `schema/table/column` taxonomy, named placeholders (`:name` works via the existing binding path), `SQL` editor identical in shape. Adapter wiring is a direct port; UI wiring is a direct port.
2. **MSSQL** is structurally identical to Postgres for schemas/tables/columns, but its query placeholder convention is `@name` rather than `:name`. The Postgres-only `substitutePostgresParams` will not work; a second helper is needed.
3. **Dynamo** is a flat key-value store: no schemas, no formal column list (the table is *schema-less* except for the partition/sort keys), and its detail-view UI (`DynamoConnectionSubtree` + `DataViewTab`) does not use the `SubtabHeader` pattern at all. The Docs panel needs a different placement, the `📄` badge attaches to the table leaf directly, and prefab queries are PartiQL with `$name`-style positional binding (DynamoDB API uses a `parameters: Vec<AttributeValue>` array, not named).

CloudWatch is excluded because no `src-tauri/src/modules/cloudwatch/` exists yet.

## Goals / Non-Goals

**Goals**

- After this change, linking a folder + running **Sync schema** works on MySQL, MSSQL, and Dynamo connections, producing the same `SyncReport` shape.
- `📄` badges, Docs panel/subtab, column-note decoration, unavailability banner, and Context Queries sidebar branch are visible on those three engines.
- Existing Postgres behaviour, tests, and code paths are untouched.
- No regressions in any of the four engines' core feature surfaces (schema browsing, structure view, data grid, SQL editor).

**Non-Goals**

- CloudWatch (no module to wire into).
- Auto-running prefab queries with native bindings (deferred for Postgres in the prior change; same deferral applies here — every engine ships with "Insert into editor" as the substitution path).
- Adding a Markdown renderer (`<pre>` placeholder remains until `react-markdown` is approved as a dep).
- Refactoring the four `ConnectionForm.tsx` into a shared form base.
- Adding Dynamo "tabs" infrastructure to match the SQL engines; we keep Dynamo's existing flatter detail view and adapt the Docs panel to fit it.

## Decisions

### D1. Extract pool-only introspection functions per engine

Today, each engine's `list_schemas`/`list_relations`/`list_structure` lives inside a Tauri `#[tauri::command]` function with the `app: AppHandle, registry: State<...>, id: String` signature. The adapter cannot call these directly — it's not a Tauri command and has no `AppHandle`.

Refactor: split each command into a pure inner function + a thin command wrapper. Example for MySQL:

```rust
// Before
#[tauri::command]
pub async fn mysql_list_schemas(
    app: AppHandle, registry: State<'_, MysqlPoolRegistry>, id: String,
) -> AppResult<Vec<SchemaInfo>> { /* … 100 lines …*/ }

// After
pub async fn list_schemas_for_pool(pool: &MySqlPool) -> AppResult<Vec<SchemaInfo>> { /* the 100 lines */ }

#[tauri::command]
pub async fn mysql_list_schemas(
    app: AppHandle, registry: State<'_, MysqlPoolRegistry>, id: String,
) -> AppResult<Vec<SchemaInfo>> {
    let pool = registry.acquire(parse_id(&id)?)?;
    let out = list_schemas_for_pool(&pool).await?;
    /* activity log + telemetry stays here */
    Ok(out)
}
```

Activity-log instrumentation stays in the command wrapper — sync isn't an "interactive" introspection and should not pollute the activity log with N×M list calls.

Same refactor for `list_relations_for_pool`, `list_structure_for_pool` on MySQL and MSSQL. For Dynamo: `list_tables_for_client(client: &DynamoClient) -> AppResult<Vec<String>>` and `describe_table_for_client(client, name) -> AppResult<TableDescription>` (the latter already exists as a pure function — just re-export).

**Why split rather than expose internals through a new trait.** A trait would force every adapter to thread a different state type through one signature, which gets ugly given that `MysqlPoolRegistry`, `MssqlPoolRegistry`, and `DynamoClientRegistry` are all `State<>`-wrapped distinct types in Tauri. Keeping the trait at the adapter boundary (`IntrospectForContext`) and using free functions for the pool-bound logic is simpler.

### D2. Adapter dispatch grows pool parameters

```rust
// Today
pub fn introspector_for<'a>(
    engine: EngineKind, pool: &'a PgPoolRegistry,
) -> Box<dyn IntrospectForContext + 'a> { … }

// After
pub fn introspector_for<'a>(
    engine: EngineKind,
    pools: IntrospectorPools<'a>,
) -> Box<dyn IntrospectForContext + 'a>;

pub struct IntrospectorPools<'a> {
    pub pg:     &'a PgPoolRegistry,
    pub mysql:  &'a MysqlPoolRegistry,
    pub mssql:  &'a MssqlPoolRegistry,
    pub dynamo: &'a DynamoClientRegistry,
}
```

The `context_sync_schema` Tauri command gains all four pool registries as `State<>` parameters, builds an `IntrospectorPools` struct, and passes it to `introspector_for`. This is mildly verbose at the call site but keeps the trait clean and avoids any global registry singleton.

### D3. Per-engine type normalisation in `ObjectShape`

`ObjectShape::kind` is a free-form string today, used by the sync executor only to set `system.kind` in the YAML frontmatter. Normalise as:

| Engine   | Object             | `ObjectShape.kind`    | `schema`              | `primary_key`                              | `columns`                           |
|----------|--------------------|----------------------|-----------------------|--------------------------------------------|-------------------------------------|
| Postgres | Table              | `"table"`             | `Some(schema_name)`   | from `get_primary_key`                     | from `list_table_columns_detailed`  |
| Postgres | View               | `"view"`              | `Some(schema_name)`   | `vec![]`                                   | column list (best-effort)           |
| Postgres | Materialized view  | `"materialized_view"` | `Some(schema_name)`   | `vec![]`                                   | column list                         |
| MySQL    | Table              | `"table"`             | `Some(schema_name)`   | `PrimaryKey.columns`                       | `TableStructureColumn.{name, data_type}` |
| MySQL    | View               | `"view"`              | `Some(schema_name)`   | `vec![]`                                   | as above                            |
| MSSQL    | Table              | `"table"`             | `Some(schema_name)`   | `PrimaryKeyInfo.columns`                   | `ColumnInfo.{name, data_type}`      |
| MSSQL    | View               | `"view"`              | `Some(schema_name)`   | `vec![]`                                   | as above                            |
| Dynamo   | Table              | `"dynamo_table"`      | `None`                | `key_schema → [partition_key, sort_key?]`  | `attribute_definitions.{name, type}` (only key attrs are typed; non-key attrs are not in the schema) |

For Dynamo `columns`: include only the typed `AttributeDefinition` entries (those are the keys and any indexed attribute). Non-key item attributes are runtime-only and intentionally absent from `system.columns`; users document them in the body / `human.column_notes` (the same key names match at the column-decoration site).

### D4. MSSQL parameter placeholder convention

MSSQL's existing SQL execution path uses tiberius which accepts `@name` named parameters. The Postgres helper `substitutePostgresParams` replaces `\b:name\b`; for MSSQL we add `substituteMssqlParams` that replaces `\b@name\b` with the same value-escaping rules (numeric/boolean raw, string single-quote-escaped — same rules apply for T-SQL literal syntax).

`openContextQuery` chooses the helper by engine:

```ts
const substitute = {
  postgres: substitutePostgresParams,
  mysql:    substitutePostgresParams,  // :name works in MySQL via the existing binding path
  mssql:    substituteMssqlParams,
  dynamo:   substituteDynamoParams,
}[engine];
```

For MySQL, `:name` is what users will write in their `.sql` files; the substitution is identical to Postgres (PostgreSQL and MySQL share `'…''…'` escape rules). MySQL's own native binding form is `?` positional, but the prefab query convention is `:name` to stay author-friendly and consistent across SQL engines.

### D5. Dynamo PartiQL parameter convention

DynamoDB's PartiQL API uses **positional** `?` placeholders with a separate `parameters: Vec<AttributeValue>` array. We cannot ship "Insert into editor" with literal substitution for Dynamo because:

1. Inserting a literal string into PartiQL changes the semantics (PartiQL has typed literals and quoting that differ from SQL).
2. Without a backend command that accepts a parameter array, there's no way to bind correctly.

**Decision**: for Dynamo, the Context Queries `.partiql` files use named placeholders `$name` purely as documentation/templating. The param strip shows the inputs, and "Insert into editor" performs a textual replacement of `$name` with a literal that is **valid PartiQL syntax for the declared `type`** (strings get `'…'` with `''` doubling, numbers raw, booleans raw, null as `NULL`). This is consistent with SQL substitution and gets the user 90% of the way there. The activity-log will show the literalised query, which is acceptable for prefab/template usage.

Document this convention in the engine table in `design.md` and in the example folder.

### D6. Dynamo Docs placement — panel instead of subtab

Dynamo's `TabView.tsx` does not use `SubtabHeader`. It has a left-side inspector and a right-side data grid. The Docs panel for a Dynamo table is rendered as a **collapsible section inside the inspector**, below the existing table metadata block. Expanded by default when the connection has a linked folder AND the current table has a documented entry.

Column notes (in Dynamo's world: *attribute notes*) are decorated in the inspector's attribute-definitions list — same idea as Postgres column notes, just rendered against the AttributeDefinition rows.

### D7. Engine routing in `openContextQuery`

`openContextQuery.ts` becomes engine-aware:

```ts
export async function openContextQuery(
  tabs: TabsApi,
  connectionId: string,
  connectionName: string,
  engine: EngineKind,
  query: QueryListItem,
): Promise<void> {
  const doc = await contextApi.getQuery(connectionId, query.name);
  if (!doc) return;
  switch (engine) {
    case "postgres": return openPostgresQueryTab(...);
    case "mysql":    return openMysqlQueryTab(...);
    case "mssql":    return openMssqlQueryTab(...);
    case "dynamo":   return openDynamoQueryTab(...);
  }
}
```

The `contextQuery` payload (with `name` and `params`) threads through each engine's existing `openQueryTab`-style helper, and each engine's editor tab renders the same `ParamStrip` above the editor. The substitution helper is picked per engine inside the tab.

### D8. Sidebar rendering in `ConnectionRow.tsx`

The Postgres branch in `ConnectionRow.tsx` already renders `<ContextQueriesBranch engine="postgres" …>`. The MySQL/MSSQL branches receive identical wiring (different `engine=` prop). The Dynamo branch wraps its existing `DynamoConnectionSubtree` with the `ContextFolderBanner` above and `ContextQueriesBranch engine="dynamo"` below.

## Risks / Trade-offs

- **Adapter refactor surface area**: extracting pool-only inner functions touches three large `schema_commands.rs` files (~1000 lines each). Mitigation: surgical extraction — leave activity-log + telemetry in the command wrapper, copy the bare SQL/pool code into the inner function, run existing tests after each extraction.
- **MySQL `:name` substitution overlap with `:` in JSON paths or `\\:` escapes**: the regex `(?<![:\w]):name(?!\w)` already used for Postgres handles MySQL identically; `::` (cast operator) doesn't apply to MySQL but the regex is safe.
- **Dynamo "schemaless columns" surprise**: the user runs Sync and sees only the partition/sort keys in `system.columns`. They might expect all known attributes. Mitigation: README + example folder explicitly document this; encourage documenting attributes in `human.column_notes` (which the decoration site reads when the attribute appears at runtime).
- **MSSQL `IDENTITY`/`COMPUTED` columns**: present in `ColumnInfo` with metadata flags but the `ObjectShape` doesn't carry them. Acceptable: the body/`human` is the place for that kind of nuance; `system.columns` stays minimal.
- **Tab opening for Dynamo prefab queries**: Dynamo doesn't currently have an explicit "PartiQL editor" tab — its UI uses a builder + raw input. The implementation chooses the simplest viable path: open the existing Dynamo SQL/PartiQL surface (look at `DataViewTab` and `QueryBuilder` to determine if there's an obvious "open with this body" entrypoint). If none exists, ship Dynamo Context Queries as **read-only display in the sidebar** for v1, with a "Copy to clipboard" action only. Flag this as a small deferral in the report. Better than guessing.
- **Test surface**: per-engine sync tests would need live DBs. Same as the Postgres adapter, the new adapters get only `cargo check` coverage; the sync executor itself remains fully tested with the fake adapter.

## Migration Plan

- No database migration; no settings changes.
- The Postgres adapter and existing Postgres UI are untouched. Existing Postgres connections keep working identically.
- The `context_sync_schema` command's external (JS) signature is unchanged — it still takes `connection_id` only. The new pool-registry `State<>` parameters are injected by Tauri.
- Rollback: revert the change; no data on disk depends on the new adapters.

## Open Questions

- **Dynamo prefab queries**: ship with "Insert into editor" working against a real PartiQL editor, or ship with copy-to-clipboard only? Investigation outcome (look for an existing Dynamo "open with body" entrypoint) decides at implementation time; if absent, ship the simpler copy-only path and add a follow-up task for native PartiQL editor.
- **MySQL/MariaDB version-specific introspection**: the existing `list_relations` SQL targets MySQL ≥ 5.7 / MariaDB ≥ 10.5. The adapter uses the same SQL, so version coverage is identical — no new version-handling work.
