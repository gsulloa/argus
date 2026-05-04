## Why

Today the table viewer (`postgres-table-data`) is data-only: opening a table shows rows and the inspector, but to see column types, defaults, primary keys, foreign keys, indexes, triggers, or the `CREATE TABLE` text the user has to leave Argus and `psql`. TablePlus solves this with three sub-tabs (Data / Structure / Raw) inside the same table tab so the schema is one click away. This change adds the same surface to Argus, finishing the V1 Postgres workflow described in the roadmap (item 8).

## What Changes

- The `postgres-table-data` viewer is wrapped in an internal sub-tabset with three tabs: **Data** / **Structure** / **Raw**. The existing Data UI (filter bar, grid, inspector, bottom bar) becomes the Data subtab and renders identically to today.
- New backend command `postgres_table_structure(id, schema, relation, origin?)` returning columns, primary key, foreign keys, unique constraints, check constraints, indexes, triggers, and a reconstructed DDL string in a single round-trip. Honors the existing partial-degradation envelope (per-kind failures) and the `argus:activity-log` event contract.
- New **Structure** subtab UI: sectioned, read-only summary of columns, constraints, indexes, triggers and FKs. Built from the response of `postgres_table_structure`.
- New **Raw** subtab UI: read-only CodeMirror 6 (Postgres dialect highlight only) showing the reconstructed DDL — `CREATE TABLE …` for tables, `CREATE VIEW …` for views, `CREATE MATERIALIZED VIEW …` for materialized views — with a Copy button.
- Sub-tab state is per-tab and per-session: switching browser tabs and back returns to the same active subtab; closing and reopening the table tab resets to **Data**. The Structure response is fetched lazily on first activation of Structure or Raw and cached for the lifetime of the tab.
- Sub-tabs are also navigable with `Cmd+1` / `Cmd+2` / `Cmd+3` (macOS) / `Ctrl+…` elsewhere while the table tab is focused.

## Capabilities

### New Capabilities
- `postgres-table-structure`: the `postgres_table_structure` command, the Structure subtab UI (columns, constraints, indexes, triggers, FKs), the Raw subtab UI (read-only DDL with Copy), and the DDL reconstruction rules per relkind.

### Modified Capabilities
- `postgres-data-grid`: the per-table viewer tab now hosts a Data/Structure/Raw sub-tabset; the existing data UI moves under the Data subtab without behavior changes.

## Impact

- **Backend** (`src-tauri/src/modules/postgres/`): a new command file (or an addition to `schema_commands.rs`) plus catalog SQL in `schema.rs` for columns + constraints + FKs. Reuses the existing `IndexInfo` / `TriggerInfo` types and the `schema::list_table_indexes` / `schema::list_table_triggers` helpers. New types in `schema_types.rs`. Registers `postgres_table_structure` in the Tauri builder.
- **Frontend** (`src/modules/postgres/`): wraps `TableViewerTab` in a sub-tabset; new components under `src/modules/postgres/structure/` for the Structure and Raw subtabs and the API binding. New activity-log kind (`table_structure`) added to the platform activity-log types.
- **Activity log**: one new `kind: "table_structure"` value added to `src/platform/activity-log/types.ts` and `ActivityLogRow.tsx`.
- **Settings/persistence**: none. Sub-tab choice is in-memory per tab.
- **Read-only & no-PK**: unchanged. The Structure and Raw subtabs are read-only regardless of connection mode.
- **Out of scope**: editing the schema (ALTER TABLE, CREATE INDEX, …) — that is `edit-postgres-schema` in V1.5; subtabs for functions / types / extensions (`Definition / Signature / Calls`) — kept inside the existing `postgres-object-placeholder` and tracked as a follow-up; sequence subtab (sequences are not in the schema browser per the V1 scope decision).
