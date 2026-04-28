## Context

`add-postgres-connection` shipped per-connection pools and the `executeQuery` helper. The sidebar shows connections; clicking one toggles connect/disconnect. Below that point the UI is empty. To replace TablePlus the next user motion is "expand a connection, find a table, click it" — that's what this change adds.

The architecture rule from previous changes still holds: the platform stays generic, the Postgres module owns everything Postgres-specific. Two implications:

1. The introspection queries (anything reading `pg_catalog` / `information_schema`) live exclusively in `src-tauri/src/modules/postgres/`. The platform never composes a Postgres SQL string.
2. The sidebar tree UI is a *platform primitive* (`SidebarTree`) but the *data* and the per-kind icons live in the postgres module. The primitive does not know what a "schema" or a "table" is.

This split matters because V2 brings DynamoDB and CloudWatch, both of which want their own browse trees. The primitive must work for "log group → log streams" and for "Dynamo table list" without knowing anything Postgres-specific.

The user flow this change must serve: connect to a database with hundreds of schemas and thousands of tables → start typing a fragment of a name → see matches collapse the tree to the relevant subtrees → click a table → an empty placeholder tab opens (real grid lands in the next change). The same flow, on a tiny dev DB with three tables, must feel instant — no loading spinners flickering for 50ms hops.

## Goals / Non-Goals

**Goals:**

- Make the sidebar grow a usable schema tree under every active Postgres connection.
- Cover every object kind a TablePlus user expects: tables, views, materialized views, functions, sequences, types, triggers, indexes, extensions.
- Keep the introspection cost bounded: O(n schemas) on connect, O(n objects) on first expand of a schema, then memory-cached for the session.
- Give the user a real search affordance (substring, case-insensitive) and a real visibility filter (multi-select schemas) so a 200-schema database is navigable.
- Establish a reusable sidebar tree primitive in `app-shell` that V2 modules will consume verbatim.

**Non-Goals:**

- DDL: creating, altering, or dropping schema objects. That's a future change.
- Tab content for the objects opened from the tree — only an empty placeholder is rendered. Each kind's viewer is its own change.
- Server-side push of catalog changes (LISTEN/NOTIFY on `pg_class`, etc.). Manual refresh covers V1.
- Full-text catalog search across connections. Per-connection search only.
- Object actions beyond "open in tab" (no "copy CREATE", no "drop", no "rename"). Right-click is reserved for V1.5.
- Sub-second pagination of giant lists. If a schema has 50k tables, it loads them all and the tree virtualizes — no incremental fetch.

## Decisions

### Decision: One coarse-grained `listObjects` instead of one query per kind

**Choice**: A single `postgres.listObjects(connectionId, schema)` returns *all* object kinds in that schema in a single struct (`SchemaObjects { tables, views, mat_views, functions, sequences, types, extensions, triggers, indexes }`). The Rust implementation issues one query per kind concurrently against the same pool acquisition (or a single CTE-joined query — see implementation note), but the IPC surface is one round-trip per schema.

**Rationale**:

- The user always expands a schema and sees *everything* in it, not just tables. Per-kind commands would require the frontend to fan out and stitch results.
- One IPC call per expansion keeps the sidebar simple — one loading state, one error path.
- The cost difference between "one query returning N tables" and "nine queries returning all kinds" is negligible against catalog tables that are already in shared buffers; latency is dominated by the round-trip, not the planning.

**Alternatives considered**:

- Per-kind commands (`listTables`, `listViews`, …): more granular but creates nine times the wiring for no observable benefit. Rejected.
- A monolithic `listEverything(connectionId)` that returns every schema's contents in one shot: cheap-looking but explodes for big databases (30k tables × every kind), and prevents lazy expansion. Rejected.

**Implementation note**: prefer one `UNION ALL` CTE assembling all kinds into a tagged result set, with a single `client.query` round-trip. If readability of the SQL suffers, fall back to nine sequential queries on one borrowed connection — they share parsing+planning across the same backend session.

### Decision: Lazy schema-level cache, manual invalidation only

**Choice**: A frontend cache keyed by `(connectionId, schema)` stores the latest `SchemaObjects` payload. First expand of a schema fetches and caches; subsequent expansions hit the cache. Cache lives in memory only — never persisted to SQLite, never restored across launches.

Invalidation triggers:

- User runs `Schema: Refresh` from the palette → drop the cache for the current connection (all schemas) and re-fetch on next expand.
- User clicks a connection's manual "↻" icon (in the row's hover toolbar) → same as `Schema: Refresh`.
- `postgres:active-changed` event for that id with `connected: false` → drop all cached entries for that connection.
- Tab switch / window blur → no invalidation. Stale catalog data is acceptable for a session.

**Rationale**: catalog data changes rarely in a developer's day. Optimistic caching is the right default; the user knows when they ran a migration and can hit Refresh. Auto-refresh on every expand wastes IPC and flickers the tree.

**Alternatives considered**:

- TTL-based cache (e.g. 5 minute eviction): adds a clock dependency for no observable benefit. Refresh button is one keypress.
- Persist cache to SQLite for cold-start instant tree: wrong correctness profile — schema can change between launches. Rejected.

### Decision: Visible-schemas selection persisted per connection

**Choice**: A per-connection setting `pgVisibleSchemas:<connectionId>` stored as a JSON array in the existing `settings` key/value table. Default: when unset, the tree shows all schemas where `nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND nspname <> 'information_schema'` (everything but Postgres-internal). System schemas are still listed, just collapsed by default behind a "Show system schemas" toggle in the picker.

The picker UI is a popover triggered from a small filter icon in the connection row's hover toolbar. It lists every schema returned by `listSchemas` with a checkbox; the user toggles, and the selection writes back to settings. The tree updates immediately.

**Rationale**:

- Real databases have dozens of schemas the user never touches (`pg_temp`, `_realtime`, `extensions`, etc.). Forcing them into the tree drowns useful schemas.
- Per-connection persistence is essential — different databases have different "noise" schemas.
- Defaulting to "everything non-system" is the right starting point — a fresh user with three schemas should see them without configuring anything.

**Alternatives considered**:

- Global "ignore patterns" setting: harder to reason about ("did I hide that here or globally?"). Rejected.
- No filter at all: doesn't scale past ~20 schemas. Rejected.

### Decision: `SchemaSummary` and `SchemaObjects` shapes

```rust
pub struct SchemaSummary {
    pub name: String,
    pub owner: String,
    pub is_system: bool,           // pg_* or information_schema
    pub comment: Option<String>,
}

pub struct SchemaObjects {
    pub schema: String,
    pub tables: Vec<TableInfo>,
    pub views: Vec<ViewInfo>,
    pub materialized_views: Vec<ViewInfo>,
    pub functions: Vec<FunctionInfo>,
    pub sequences: Vec<SequenceInfo>,
    pub types: Vec<TypeInfo>,
    pub extensions: Vec<ExtensionInfo>,
    // Per-table sub-collections — keyed by parent table name, scoped to this schema.
    pub indexes: Vec<IndexInfo>,
    pub triggers: Vec<TriggerInfo>,
}

pub struct TableInfo { pub name: String, pub owner: String, pub estimated_rows: Option<i64>, pub comment: Option<String>, pub kind: TableKind }
pub enum TableKind { Regular, Partitioned, Foreign }
pub struct ViewInfo { pub name: String, pub owner: String, pub comment: Option<String> }
pub struct FunctionInfo { pub name: String, pub args_signature: String, pub return_type: String, pub language: String, pub comment: Option<String> }
pub struct SequenceInfo { pub name: String, pub owner: String, pub last_value: Option<i64> }
pub struct TypeInfo { pub name: String, pub kind: TypeKind, pub comment: Option<String> }
pub enum TypeKind { Composite, Enum, Domain, Range }
pub struct ExtensionInfo { pub name: String, pub version: String, pub comment: Option<String> }
pub struct IndexInfo { pub name: String, pub table: String, pub is_unique: bool, pub is_primary: bool, pub method: String }
pub struct TriggerInfo { pub name: String, pub table: String, pub timing: TriggerTiming, pub events: Vec<TriggerEvent>, pub function: String }
pub enum TriggerTiming { Before, After, InsteadOf }
pub enum TriggerEvent { Insert, Update, Delete, Truncate }
```

The TS mirror lives in `src/modules/postgres/schema/types.ts` (string-literal unions for the enums).

**Rationale**: each shape carries the metadata the *tree* needs (name, parent, light decoration like "RO" for views without `ON UPDATE` rules), not the full structure (no column lists, no DDL). The full structure for a table comes from `postgres.tableStructure(connectionId, schema, table)` in `table-structure-tab` (change #8) — we explicitly avoid pre-loading it here.

`estimated_rows` comes from `pg_class.reltuples` (cheap, approximate). The exact `COUNT(*)` is a separate user action in `view-table-data` (change #4). Surfacing the estimate in the tree gives a "this table is big" hint without a count query.

### Decision: Introspection queries — pg_catalog, not information_schema

**Choice**: All introspection uses `pg_catalog` joined to `pg_namespace`. `information_schema` is avoided.

**Rationale**:

- `information_schema` is SQL-standard but loses Postgres specifics (partitioned tables, foreign tables, materialized views, ranges, extensions). It also performs worse for large catalogs because of its view-on-view layering.
- `pg_catalog` is stable across Postgres versions for the columns we care about (`pg_class.relkind`, `pg_proc`, `pg_type`, etc.). The schema browser deliberately targets Postgres 12+ (libpq-supported lower bound) so we lean into Postgres-native columns.

**Alternatives considered**: hybrid (info_schema for portability, pg_catalog for Postgres-specifics) — adds query complexity without gaining anything since this is a Postgres-only module. Rejected.

**Reference query sketches** (full SQL in `schema.rs`):

```sql
-- listSchemas
SELECT n.nspname AS name,
       pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
       (n.nspname LIKE 'pg\_%' ESCAPE '\' OR n.nspname = 'information_schema') AS is_system,
       d.description AS comment
FROM pg_catalog.pg_namespace n
LEFT JOIN pg_catalog.pg_description d
  ON d.objoid = n.oid AND d.objsubid = 0
ORDER BY is_system, name;

-- listObjects: tables
SELECT c.relname AS name,
       pg_catalog.pg_get_userbyid(c.relowner) AS owner,
       c.reltuples::bigint AS estimated_rows,
       d.description AS comment,
       c.relkind AS rk          -- 'r' regular, 'p' partitioned, 'f' foreign
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_description d
  ON d.objoid = c.oid AND d.objsubid = 0
WHERE n.nspname = $1 AND c.relkind IN ('r','p','f')
ORDER BY c.relname;
```

Similar single-statement queries for views (`relkind = 'v'`), mat-views (`'m'`), sequences (`'S'`), indexes (`'i'`), functions (`pg_proc`), types (`pg_type` with `typtype`), extensions (`pg_extension`), triggers (`pg_trigger` filtered to non-internal: `NOT tgisinternal`).

### Decision: Sidebar tree primitive (`SidebarTree`) lives in `app-shell`

**Choice**: A platform-level component that renders an arbitrary tree of nodes with:

- ARIA `tree`/`treeitem` semantics (single-select, multi-expandable).
- Keyboard nav: ↑/↓ moves selection, ←/→ collapses/expands, Enter activates (calls `onActivate(node)`), Home/End jump to first/last visible node, type-ahead for substring matches.
- Visual: indent guides, expand caret, optional leading icon per node (via render prop), optional trailing badge.
- Virtualization threshold: for trees over 500 visible nodes, the scroller virtualizes (using `@tanstack/react-virtual`, already in the bundle for the upcoming data grid). Below the threshold, render plain DOM.

The primitive accepts a `nodes: TreeNode[]` and an `onActivate` callback. Postgres-specific concerns (object kinds, icons, badges) are passed in via props/render functions — the primitive doesn't import anything from `src/modules/postgres/`.

**Rationale**: ARIA tree semantics are a "get it right once" deal. Building it inside the postgres module would mean re-deriving the same logic for Dynamo and CloudWatch in V2.

**Alternatives considered**:

- A third-party tree library (e.g. `react-arborist`): heavier, less control over keyboard semantics, harder to match the rest of the shell's visual style. Rejected.
- A bespoke Postgres-only tree: short-term cheap, long-term wrong (V2 modules would re-implement). Rejected.

### Decision: Search behavior

**Choice**: A search input above each connection's tree. Typing N characters filters all *loaded* objects in that connection by case-insensitive substring against `<schema>.<name>`. The tree visually:

- Hides nodes that don't match.
- Auto-expands ancestor nodes whose subtree contains a match.
- Highlights matched substrings within node labels.
- Pressing Esc clears.

Search does *not* trigger fetches — it operates on already-loaded data. If the user expects to find an object in a schema they haven't expanded yet, the empty-result UI suggests "Schema X has not been loaded — expand it to include in search."

**Rationale**: triggering fetches from a search input is a footgun (typing "p" loads every schema). Forcing the user to expand schemas they care about scales linearly with how much they actually browse.

**Alternatives considered**:

- Auto-load all schemas eagerly so search is global: doesn't scale. Rejected.
- Server-side `pg_catalog` search query: nice idea, deferred to a future `schema-search` change.

### Decision: Object click opens an empty placeholder tab

**Choice**: Activating any node (Enter, click, double-click — all equivalent) calls a frontend dispatcher `openObjectTab({ connectionId, schema, kind, name, ...kindSpecific })` that opens or focuses a tab in the center area. For V1, every object kind opens a tab kind `postgres-object-placeholder` with a body that says "Viewer for `<schema>.<name>` (`<kind>`) not implemented yet." The tab carries the full identity payload so future viewer changes can replace the placeholder by registering tab kinds for `postgres-table`, `postgres-function`, etc., reading the same payload.

**Rationale**: shipping the schema tree without any tab destination feels broken. A clearly-labeled placeholder tab makes the contract obvious to the user ("we know about your click; the viewer's coming") and gives subsequent changes a concrete payload to plug into.

**Alternatives considered**:

- No-op on click until viewers exist: feels broken. Rejected.
- Open a tab kind unique per object kind even though all render placeholders: extra wiring with no payoff. Reusing one tab kind keeps the tab list tidy.

### Decision: Sidebar layout — tree under the row, not in a separate pane

**Choice**: When a connection becomes active, the row expands to reveal the tree directly underneath, indented under the row. Disconnect collapses the tree away. Multiple connections active = multiple trees stacked vertically, each scrolling independently if needed.

**Rationale**: this is the TablePlus / DBeaver / pgAdmin idiom. Users expect it. A dedicated "schema browser" pane elsewhere would force pane management for no benefit.

**Alternatives considered**:

- Right-side panel showing the tree of the *currently focused* connection: cute but means the user can't see schemas of two databases side-by-side. Rejected.

## Risks / Trade-offs

- **Catalog query cost on huge schemas** → Some `pg_catalog` queries against schemas with tens of thousands of objects can take seconds. Mitigation: the `listObjects` queries are already filtered by schema; we accept that the very first expand of a giant schema is slow and show a loading state. If real users complain, add `LIMIT` + paging in a follow-up.
- **Stale cache after a migration the user ran in another tool** → User expects the table they just created to appear; it doesn't until they hit Refresh. Mitigation: prominent ↻ button on each connection row + palette command. Document the behavior in the onboarding tab once we have one.
- **Search hides what the user expects to see** → If the user types something and the tree visibly empties, they may think "the database is broken". Mitigation: search input always shows "X of Y nodes matching" inline, and an explicit empty state shows "No matches in *loaded* schemas (N schemas not yet loaded)".
- **`relkind = 'f'` foreign tables surface but cannot be browsed in V1** → The data grid in `view-table-data` doesn't implement foreign table semantics. Mitigation: render foreign tables in the tree with a small "FDW" badge, and the placeholder tab is honest about not supporting them yet.
- **Permission-restricted catalog access** → On managed Postgres (Aurora, Cloud SQL) some `pg_catalog` columns require `pg_read_all_metadata` or similar. Mitigation: on permission errors, render the schema with a permission-denied marker rather than failing the whole tree, and `tracing::warn!` the specific object kind that failed.
- **Tree primitive scope creep** → Once `SidebarTree` exists, every subsequent feature wants to add a prop. Mitigation: explicit non-goals in the primitive's docstring; new props require a separate change touching `app-shell`.
- **Virtualization breaking keyboard nav** → React-virtual + ARIA tree is fiddly. Mitigation: keyboard nav code operates on the in-memory `nodes` array, not the rendered DOM, so virtualization doesn't affect it; the virtualized rows just render whatever subset is visible.

## Migration Plan

Greenfield within the V1 trajectory. Steps:

1. Add the `SidebarTree` primitive in `src/platform/shell/SidebarTree.tsx` with its keyboard/ARIA story (no postgres imports).
2. Implement the Rust introspection in `src-tauri/src/modules/postgres/schema.rs` and the two commands (`postgres.listSchemas`, `postgres.listObjects`).
3. Mirror types in `src/modules/postgres/schema/types.ts` and write the typed API wrapper.
4. Build the postgres-specific `<SchemaTree connectionId={…} />` that consumes `SidebarTree` plus the cache hook.
5. Wire `<SchemaTree />` under each connection row in `Sidebar.tsx`.
6. Add the visible-schemas picker popover and `pgVisibleSchemas:<id>` settings persistence.
7. Add the empty `postgres-object-placeholder` tab kind to the tab registry.
8. Register the two palette commands.

No SQLite migration. No new keychain entries. Rollback is a code revert.

## Open Questions

- **Indexes and triggers as siblings or children of their parent table?** Visually nicer to render under the table (indented further). The data already comes back keyed by parent. Default decision: render as children of the table node. Re-evaluate during implementation if perf is a concern.
- **Function overloads** — Postgres allows overloads with different argument lists. Should the tree show `myfn(int)` and `myfn(text)` as siblings or under one collapsible `myfn` group? Default: siblings, full signature in the label, no grouping. Group later if many overloads cause noise.
- **Should `Schema: Refresh` rebuild `listSchemas` too, or only invalidate per-schema caches?** Default: rebuild both — schemas come and go too. The cost is a single fast query.
- **Hovering a node shows what?** Default for V1: a tooltip with `<schema>.<name>` (kind). Defer comment / row-count / DDL preview to a polish change once the tree is exercised in real use.
