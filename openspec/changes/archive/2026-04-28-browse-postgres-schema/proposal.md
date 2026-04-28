## Why

Once a Postgres connection is open, the next thing the user expects is "show me what's in this database". Today the sidebar has connection rows but clicking them only toggles connect/disconnect — there is nothing below the row. To replace TablePlus, Argus needs a navigable schema tree (schemas → tables, views, materialized views, functions, sequences, types, indexes, triggers, extensions) with search and a multi-select schema filter, so the user can find an object and open it in seconds. This change ships that tree and the two introspection commands behind it. It is the prerequisite for `view-table-data`, `run-sql` autocomplete, and `table-structure-tab`.

## What Changes

- New Postgres schema browser module on the Rust side (`src-tauri/src/modules/postgres/schema.rs` plus commands) and the TS side (`src/modules/postgres/schema/`).
- Tauri command `postgres.listSchemas(connectionId) -> Vec<SchemaSummary>` returning every schema visible to the connection user, with a flag indicating whether it is a system schema (`pg_*`, `information_schema`).
- Tauri command `postgres.listObjects(connectionId, schema) -> SchemaObjects` returning, for that schema: tables, views, materialized views, functions (with overload disambiguators), sequences, composite/enum/domain types, triggers (per-table), indexes (per-table), extensions installed in the schema. Each item carries the metadata the tree needs (name, owner, comment, oid, parent table for triggers/indexes).
- Frontend schema browser hangs under each connected sidebar row: collapsible tree with icons per object kind, lazy load per schema (objects fetched on first expand and cached for the session).
- Schema-level search box at the top of each connection's tree filters across all loaded objects in that connection by substring (case-insensitive). Result list highlights matches and preserves tree grouping.
- Multi-select "visible schemas" picker (small popover from a filter icon) lets the user choose which schemas to render. Selection persists per connection in `settings` under key `pgVisibleSchemas:<connectionId>` and defaults to "all non-system schemas".
- Click on any object opens an empty placeholder tab in the center work area with the object's identity (kind, schema, name) — concrete tab contents land in later changes (`view-table-data`, `table-structure-tab`, etc.).
- Sidebar acquires a generic "hierarchical search section" affordance in `app-shell` so other future modules (Dynamo browse, CloudWatch log groups) can use the same primitive.
- The app-shell sidebar gains a tree primitive (`<SidebarTree>`) with keyboard navigation (↑/↓ to move, ←/→ to collapse/expand, Enter to open) and ARIA `tree`/`treeitem` semantics.
- Two palette commands: `Schema: Refresh` (drops the cached objects for the current connection and re-fetches) and `Schema: Filter Visible…` (opens the multi-select for the current connection).

**Out of scope** (deferred):

- Editing the schema (DDL): `create-postgres-schema-object`, `edit-postgres-schema-object` are post-V1.
- Diff between two databases or between two schemas — separate change if pain emerges.
- ER diagrams / visual relationships.
- Tab content beyond the placeholder (every kind's actual viewer is its own change).
- Cross-schema search / global search across connections — `schema-search` is a documented future change.
- Streaming refresh on DDL events from Postgres (LISTEN/NOTIFY of `pg_*` catalog updates) — manual refresh is enough for V1.

## Capabilities

### New Capabilities

- `postgres-schema-browser`: Postgres-specific schema introspection commands, the per-connection object cache, and the sidebar tree UI that renders the result. Owns the shape of `SchemaSummary` and `SchemaObjects`, the lazy-load policy, and the visible-schemas persistence key.

### Modified Capabilities

- `app-shell`: gains a reusable `SidebarTree` primitive and the contract that sidebar sections may host hierarchical, searchable subtrees with keyboard navigation. The tree is a platform primitive so V2 modules can reuse it without re-implementing keyboard semantics.

## Impact

- **New code**:
  - Rust: `src-tauri/src/modules/postgres/schema.rs` (queries against `pg_catalog` / `information_schema`), `src-tauri/src/modules/postgres/schema_commands.rs` (Tauri command registration), shared types in `src-tauri/src/modules/postgres/schema_types.rs`.
  - TypeScript: `src/modules/postgres/schema/api.ts`, `types.ts`, `useSchemaTree.ts` (cache + invalidate), `SchemaTree.tsx`, `VisibleSchemasPicker.tsx`, `SchemaSearch.tsx`, `objectIcons.tsx`.
  - TypeScript platform: `src/platform/shell/SidebarTree.tsx` and a small CSS/Tailwind contribution; ARIA tree behavior centralized here.
  - Migration: none. Visible-schemas selection lives in the existing `settings` table as a JSON-encoded string array.
- **Modified files**:
  - `src/platform/shell/Sidebar.tsx` — connection rows render a `<SchemaTree connectionId={id} />` underneath when the connection is active.
  - `src/modules/postgres/commands.ts` — registers `Schema: Refresh` and `Schema: Filter Visible…` in addition to the existing connection commands.
  - `src-tauri/src/lib.rs` — registers the new schema commands.
- **No new Rust dependencies**. Uses the existing `tokio-postgres` pool + `executeQuery` helper from `add-postgres-connection`.
- **No new JS dependencies**. The tree uses Radix `Collapsible` (already in the bundle for the connection form) and Tailwind for layout. Icons come from existing Lucide set; `<PostgresIcon />` from the previous change is reused for connection rows.
- **No breaking changes**. The sidebar rendering of connection rows still toggles connect/disconnect on click; the tree appears below an already-active row.
- **User-visible change**: the sidebar grows a navigable tree under each connected Postgres database. Search and visible-schemas filter become discoverable. Clicking objects opens placeholder tabs (real content in subsequent changes).
