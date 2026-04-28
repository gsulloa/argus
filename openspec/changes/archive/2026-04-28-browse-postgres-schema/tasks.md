## 1. Sidebar tree primitive (app-shell)

- [x] 1.1 Create `src/platform/shell/SidebarTree.tsx` exposing a `<SidebarTree nodes onActivate renderIcon? renderBadge? virtualizationThreshold?=500 />` component with no module-specific imports
- [x] 1.2 Implement the in-memory tree model: `TreeNode { id: string, label: string, level: number, kind: "leaf"|"parent", children?: TreeNode[], data?: unknown }`; expansion state lives in a `Map<id, boolean>` owned by the primitive
- [x] 1.3 Implement ARIA semantics: root `role="tree"`, each node `role="treeitem"` with `aria-level`, `aria-expanded` for parents, `aria-selected` reflecting the focused/selected node
- [x] 1.4 Implement keyboard navigation: ↑/↓ between visible nodes, ←/→ collapse-or-walk-up / expand-or-walk-down, Enter calls `onActivate(node)`, Home/End jump first/last, type-ahead matches printable prefixes (case-insensitive)
- [x] 1.5 Implement virtualization with `@tanstack/react-virtual` only when visible-node count exceeds `virtualizationThreshold` (default 500); below the threshold render plain DOM
- [x] 1.6 Truncate long labels with CSS ellipsis and expose the full label as `title` for tooltip-on-hover; verify it lays out within the persisted sidebar width
- [~] 1.7 Demo route deferred — `SchemaTree` (section 8) consumes `SidebarTree` directly under live connections, providing exercise during dev. A standalone demo page would add maintenance noise.
- [~] 1.8 Unit tests deferred — repo has no Vitest setup; adding test infrastructure is its own change. Manual exercise via section 12 covers the behaviors. Captured as a follow-up below.

## 2. Rust schema-types and shared shapes

- [x] 2.1 Create `src-tauri/src/modules/postgres/schema_types.rs` defining `SchemaSummary`, `SchemaObjects`, `TableInfo`, `TableKind`, `ViewInfo`, `FunctionInfo`, `SequenceInfo`, `TypeInfo`, `TypeKind`, `ExtensionInfo`, `IndexInfo`, `TriggerInfo`, `TriggerTiming`, `TriggerEvent` exactly as in `design.md`
- [x] 2.2 Derive `Serialize`/`Deserialize` keeping snake_case field names (matches existing `ActivePoolSummary`, `ConnectResult`, etc. convention); for enums use `#[serde(rename_all = "lowercase")]`
- [x] 2.3 Wire `pub mod schema_types;` from `src-tauri/src/modules/postgres/mod.rs`

## 3. Rust schema introspection queries

- [x] 3.1 Create `src-tauri/src/modules/postgres/schema.rs`
- [x] 3.2 Implement `list_schemas(pool) -> Result<Vec<SchemaSummary>, AppError>` running the `pg_namespace` query from `design.md`; mark `is_system` for `pg_*` and `information_schema`
- [x] 3.3 Implement `list_tables(pool, schema)` against `pg_class` filtered to `relkind IN ('r','p','f')`; populate `kind` from `relkind` mapping `'r' → Regular`, `'p' → Partitioned`, `'f' → Foreign`; surface `reltuples::bigint` as `estimated_rows`; left-join `pg_description` for comments
- [x] 3.4 Implement `list_views(pool, schema)` against `pg_class` filtered to `relkind = 'v'` and `list_materialized_views(pool, schema)` for `relkind = 'm'`
- [x] 3.5 Implement `list_functions(pool, schema)` against `pg_proc` joined to `pg_namespace`; include the full `pg_get_function_arguments(p.oid)` as `args_signature`, `pg_get_function_result(p.oid)` as `return_type`, language name from `pg_language`
- [x] 3.6 Implement `list_sequences(pool, schema)` against `pg_class` filtered to `relkind = 'S'`; lazily skip `last_value` (leave `None`) — fetching it would require executing `SELECT last_value FROM <seq>` which is out of scope for V1
- [x] 3.7 Implement `list_types(pool, schema)` against `pg_type` filtered to user-defined types (`typtype IN ('c','e','d','r')` for composite/enum/domain/range, and exclude rows where `typrelid` references a relation already returned as a table)
- [x] 3.8 Implement `list_extensions(pool, schema)` against `pg_extension` filtered to extensions installed in the given namespace
- [x] 3.9 Implement `list_indexes(pool, schema)` against `pg_index` joined to `pg_class` (the index) and `pg_class` again (the table); surface `is_unique`, `is_primary`, and the access method (`pg_am.amname`)
- [x] 3.10 Implement `list_triggers(pool, schema)` against `pg_trigger` filtered to `NOT tgisinternal`; decode `tgtype` bitmask into `timing` and `events`; resolve the function via `pg_proc`
- [x] 3.11 Implement `list_objects(pool, schema) -> Result<SchemaObjects, AppError>` that calls each helper sequentially on a single borrowed connection; on permission-denied (`SQLSTATE 42501`) for any single kind, return an empty Vec for that kind, log via `tracing::warn!`, and continue with the others
- [x] 3.12 Add Rust unit tests for the trigger-bitmask decoder (timing + events), table/type kind mappings, and the SQLSTATE 42501 detector. Live-DB integration tests deferred — would require provisioning a Postgres in CI; the decoder/mapper units cover the most error-prone Rust logic.

## 4. Rust commands

- [x] 4.1 Create `src-tauri/src/modules/postgres/schema_commands.rs`
- [x] 4.2 Implement `#[tauri::command] async fn postgres_list_schemas(state: State<PgPoolRegistry>, connection_id: Uuid) -> Result<Vec<SchemaSummary>, AppError>`; resolve the pool from the registry (return `AppError::NotFound` if absent), borrow a connection, call `schema::list_schemas`
- [x] 4.3 Implement `#[tauri::command] async fn postgres_list_objects(state: State<PgPoolRegistry>, connection_id: Uuid, schema: String) -> Result<SchemaObjects, AppError>`; same pool resolution; call `schema::list_objects`
- [x] 4.4 Register both commands in `src-tauri/src/lib.rs` `tauri::generate_handler![…]`
- [x] 4.5 Add a single `pub(crate) async fn acquire(&self, id: &Uuid) -> AppResult<deadpool_postgres::Object>` on `PgPoolRegistry` so the schema commands can share one borrowed client across the 9 introspection queries (design 3.11). Visibility is `pub(crate)` — modules outside `postgres::` cannot bypass the read-only mutation gate.

## 5. Frontend types and API wrapper

- [x] 5.1 Create `src/modules/postgres/schema/types.ts` mirroring the Rust shapes (string-literal unions for `TableKind`, `TypeKind`, `TriggerTiming`, `TriggerEvent`)
- [x] 5.2 Create `src/modules/postgres/schema/api.ts` exporting `listSchemas(connectionId)` and `listObjects(connectionId, schema)` typed wrappers around `invoke(...)`
- [x] 5.3 Re-export from `src/modules/postgres/index.ts` so consumers import via the module barrel

## 6. Schema cache hook

- [x] 6.1 Create `src/modules/postgres/schema/useSchemaTree.ts` exposing `{ schemas, isLoading, error, getObjects(schema), invalidate(), invalidateSchema(schema) }` for a given `connectionId`
- [x] 6.2 Internally maintain a `Map<schema, { state: "idle"|"loading"|"loaded"|"error", payload?: SchemaObjects, error?: AppError }>`; `getObjects` triggers a fetch on `idle` and returns the cached payload on `loaded`
- [x] 6.3 Subscribe to `postgres:active-changed` and clear the cache for the connection id when it transitions to inactive
- [x] 6.4 `invalidate()` clears the entire cache for the connection (including `schemas`) and re-fetches on next render
- [x] 6.5 Memoize the hook's return value to avoid spurious re-renders of `<SchemaTree>`

## 7. Visible-schemas filter

- [x] 7.1 Create `src/modules/postgres/schema/useVisibleSchemas.ts` reading/writing `pgVisibleSchemas:<connectionId>` via the existing `settings` API
- [x] 7.2 Default behavior when unset: return all `schemas` filtered to `!isSystem`; `showSystem` toggle adds `isSystem` schemas
- [x] 7.3 Persist on every change; debounce write by ~150ms to avoid flooding `settings.set`
- [x] 7.4 Create `src/modules/postgres/schema/VisibleSchemasPicker.tsx` using `@radix-ui/react-dropdown-menu` (Radix Popover not installed — DropdownMenu fits checkbox-list semantics natively). Includes "Show system schemas" toggle, "Select all"/"Clear" actions; the trigger is a small filter icon button supplied via `<SchemaToolbar>` into the connection row's hover toolbar.

## 8. SchemaTree component

- [x] 8.1 Create `src/modules/postgres/schema/objectIcons.tsx` mapping each kind to a Lucide icon component (Tables/Views/Mat-views/Functions/Sequences/Types/Extensions/Indexes/Triggers); per-row icon dimension matches the existing `<PostgresIcon />` weight
- [x] 8.2 Create `src/modules/postgres/schema/SchemaSearch.tsx` — controlled input with "X of Y" indicator and an Esc-to-clear behavior; exposes `query` to the parent
- [x] 8.3 Create `src/modules/postgres/schema/SchemaTree.tsx` consuming `useSchemaTree`, `useVisibleSchemas`, and `SchemaSearch`; assembles `TreeNode[]` for `SidebarTree` from the cached `SchemaObjects`
- [x] 8.4 Group children of a schema under kind nodes (Tables, Views, Materialized Views, Functions, Sequences, Types, Extensions); each kind node displays an item count
- [x] 8.5 Render table nodes with two child kind nodes (Indexes, Triggers) when their respective collections are non-empty
- [x] 8.6 Apply search filtering: nodes whose label does not contain the substring (case-insensitive) are dropped; ancestors of any match are auto-expanded; the "X of Y" indicator reflects matches across loaded objects
- [x] 8.7 Render the "FDW" badge on tables with `kind: "foreign"` via the `renderBadge` slot of `SidebarTree`
- [x] 8.8 Empty-state copy when search yields zero matches AND there are unloaded schemas: "No matches in loaded schemas. N schemas not yet loaded — expand a schema to include it in search."
- [x] 8.9 On node activation, dispatch `openObjectTab({ connectionId, schema, kind, name, signature? })` to the tab registry (group nodes do not dispatch)

## 9. Tab registry — placeholder kind

- [x] 9.1 Register a tab kind `postgres-object-placeholder` in the existing tab kind registry with payload `{ connectionId: string, schema: string, kind: string, name: string, signature?: string }`
- [x] 9.2 Implement the renderer as a centered card showing `<schema>.<name>` (kind), the connection name, and a faint "Viewer not implemented yet — coming in a future change" message
- [x] 9.3 Implement focus-existing behavior: `openObjectTab` checks for an existing tab with the same `(connectionId, schema, kind, name, signature)` and focuses it instead of opening a duplicate
- [x] 9.4 Define the helper `openObjectTab(payload)` in `src/modules/postgres/schema/openObjectTab.ts`

## 10. Sidebar wiring

- [x] 10.1 In `src/platform/shell/Sidebar.tsx` (or wherever the connection list lives), render `<SchemaTree connectionId={id} />` directly under each connection row whose `useActiveConnections().isActive(id)` returns true
- [x] 10.2 Add a hover toolbar to each connection row with the refresh button (↻ icon — calls `useSchemaTree(id).invalidate()`) and the visible-schemas picker trigger
- [x] 10.3 Verify multiple active connections each render their own tree, stacked vertically and scrolling independently when overflowing

## 11. Palette commands

- [x] 11.1 In `src/modules/postgres/commands.ts` register on app mount: `Schema: Refresh` and `Schema: Filter Visible…` alongside the existing connection commands
- [x] 11.2 `Schema: Refresh` resolves the focused connection and calls `useSchemaTree(id).invalidate()`; if no focused connection, transition the palette to a chooser listing connected Postgres connections
- [x] 11.3 `Schema: Filter Visible…` resolves the focused connection and opens the `VisibleSchemasPicker` for it; if no focused connection, transition to the same chooser

## 12. Build-level verification (automated) and manual acceptance

Automated (run by the implementing agent):

- [x] 12.0a `pnpm typecheck` — passes (0 errors)
- [x] 12.0b `pnpm lint` — passes (0 errors; warnings are pre-existing `react-refresh/only-export-components` advisories matching the convention used in `welcome.tsx`/`settings-placeholder.tsx`)
- [x] 12.0c `pnpm build` — vite build succeeds, 1725 modules transformed, ~106 kB gzipped JS
- [x] 12.0d `cargo clippy --all-targets -- -D warnings` — clean
- [x] 12.0e `cargo test --lib` — 39 / 39 tests pass (5 new tests for trigger/kind decoders + permission-denied detector)

Manual acceptance (user-driven — requires a live Postgres):

- [ ] 12.1 `pnpm tauri dev`; connect to a local Postgres with `public` and `analytics` schemas; expand both — every kind populated correctly with item counts
- [ ] 12.2 Verify type-ahead in the tree: focus a node, type letters, focus jumps to the next matching node
- [ ] 12.3 Type a substring in the search box — matching nodes remain, ancestors auto-expand, "X of Y" indicator updates; press Esc — tree returns to pre-search state
- [ ] 12.4 Open the visible-schemas picker, hide `analytics`, close — `analytics` disappears; quit and relaunch — `analytics` still hidden
- [ ] 12.5 Toggle "Show system schemas" — `pg_catalog` and `information_schema` appear at the bottom
- [ ] 12.6 Click a table node — placeholder tab opens with correct identity; click again — same tab focuses (no duplicate)
- [ ] 12.7 ⌘K → `Schema: Refresh` — tree briefly shows loading then re-renders with current catalog state (verify by creating a table in another tool first)
- [ ] 12.8 Disconnect a connection — its tree disappears from the sidebar; reconnect — tree reappears with a freshly fetched payload (cache was dropped on disconnect)
- [ ] 12.9 On a database with 200+ schemas, verify the picker scrolls; on a schema with 1000+ objects, verify the tree virtualizes smoothly
- [ ] 12.10 With a connection user that lacks privilege on `pg_extension`, expand a schema — the tree renders with an empty Extensions group, other kinds populated, and a `tracing::warn!` appears in the dev console
- [ ] 12.11 Build a release bundle with `pnpm tauri build` and confirm the schema browser works against the same database

## Follow-ups (not blocking this change)

- Add Vitest + React Testing Library setup as its own change so future component changes can ship with unit tests. Targets: `SidebarTree` keyboard nav, `SchemaTree` filter logic, `useSchemaTree` cache invalidation.
- Live integration tests for `schema::list_objects` gated behind `cfg(feature = "live-pg-tests")`, mirroring the pattern in `pool.rs`.
