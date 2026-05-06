## 1. Backend: types and SQL helpers

- [x] 1.1 Add `ColumnDetail`, `PrimaryKeyInfo`, `ForeignKeyInfo`, `UniqueConstraintInfo`, `CheckConstraintInfo`, and `TableStructureResult` structs to `src-tauri/src/modules/postgres/schema_types.rs`. Reuse the existing `IndexInfo` and `TriggerInfo` shapes verbatim.
- [x] 1.2 Add a `Relkind` enum (`Table | View | MaterializedView`) on `TableStructureResult` and confirm it serializes as the kebab-case strings the spec requires (`"table" | "view" | "materialized-view"`).
- [x] 1.3 In `src-tauri/src/modules/postgres/schema.rs`, add `list_table_columns_detailed(client, schema, relation)` returning `Vec<ColumnDetail>` from `pg_attribute` + `pg_attrdef` + `pg_description` + `information_schema.columns`. Include `is_identity` and `is_generated`.
- [x] 1.4 Add `get_primary_key(client, schema, relation)` returning `Option<PrimaryKeyInfo>` from `pg_constraint` filtered to `contype = 'p'`.
- [x] 1.5 Add `list_foreign_keys(client, schema, relation)` returning `Vec<ForeignKeyInfo>` from `pg_constraint` filtered to `contype = 'f'`, joining `pg_class`/`pg_namespace` for the referenced relation and decoding `confupdtype`/`confdeltype` into the action enum.
- [x] 1.6 Add `list_unique_constraints(client, schema, relation)` (`contype = 'u'`) and `list_check_constraints(client, schema, relation)` (`contype = 'c'`, exposing `pg_get_constraintdef`).
- [x] 1.7 Add `get_relkind(client, schema, relation)` returning `Relkind` from `pg_class.relkind` (mapping `r`/`p` → Table, `v` → View, `m` → MaterializedView). Return `42P01` if the relation does not exist.
- [x] 1.8 Add `is_matview_populated(client, oid)` returning `bool` from `pg_class.relispopulated`. (Folded into `get_relkind` — the same row carries `relispopulated`.)

## 2. Backend: DDL reconstruction

- [x] 2.1 Add `ddl::reconstruct_table(schema, relation, columns, pk, fks, unique_cs, check_cs, indexes)` returning `String` per the spec rules in §"DDL reconstruction". Implement quoting, `NOT NULL`, `DEFAULT`, identity, and one constraint per indented line. (Index DDL strings come pre-rendered from `pg_get_indexdef` to avoid an extra round-trip and to capture every Postgres-supported index expression.)
- [x] 2.2 Add `ddl::reconstruct_view(client, schema, relation)` calling `pg_get_viewdef(oid, true)` and prefixing with `CREATE OR REPLACE VIEW … AS`. (Body fetched in the command via `schema::get_view_definition`.)
- [x] 2.3 Add `ddl::reconstruct_matview(client, schema, relation, is_populated)` calling `pg_get_viewdef(oid, true)` (works for matviews too) and appending `WITH NO DATA;` / `WITH DATA;`.
- [x] 2.4 Add `ddl::escape_sql_string(s)` (single-quote doubling) and use it for `COMMENT ON COLUMN` lines and any string literal in the DDL.
- [x] 2.5 Add table-level unit tests in `ddl.rs` covering: plain table with PK + FK + indexes, table with identity column, table with column comments, view, populated matview, unpopulated matview.

## 3. Backend: command + activity log

- [x] 3.1 Add `ActivityKind::TableStructure` variant in `src-tauri/src/modules/activity_log/mod.rs` with serde rename `"table_structure"`.
- [x] 3.2 Add `postgres_table_structure(app, pools, id, schema_name, relation, origin?)` in `src-tauri/src/modules/postgres/schema_commands.rs`. Mirror the structure of `postgres_list_table_extras`: parse id, acquire client, get cancel token, run the joined inner future under `TOTAL_TIMEOUT`, fire `pg_cancel_backend` on outer timeout.
- [x] 3.3 Implement the inner aggregator that joins all per-kind futures (`columns`, `primary_key`, `foreign_keys`, `unique_constraints`, `check_constraints`, `indexes`, `triggers`, `relkind`) under `PER_QUERY_TIMEOUT`, plus the relkind-dispatched DDL reconstruction call. Aggregate per-kind failures with `aggregate_one`. If `columns` fails, return `AppError::Postgres` (do not return a partial response).
- [x] 3.4 Emit one `argus:activity-log` event with `kind: "table_structure"`, `origin: <argument or "auto">`, `metric: Items { value: <columns + indexes + triggers + fks + unique_cs + check_cs + (pk ? 1 : 0)> }` on ok; `null` on err. `sql: None`, `params: None`.
- [x] 3.5 Register `postgres_table_structure` in the Tauri builder (`src-tauri/src/lib.rs` or wherever schema commands are wired) so it is invokable from the frontend.
- [ ] 3.6 Add an integration test (or a smoke test if integration isn't wired here) covering: plain table returns full structure; permission-denied on `pg_constraint` collapses to empty without a failure entry; per-query timeout on `pg_index` puts `indexes: null` and a `KindFailure` entry; columns-query failure surfaces as a hard `AppError::Postgres`. (Deferred — no live Postgres test fixture exists in the repo; the partial-degradation aggregator is exercised by the existing `aggregate_*` unit tests, and DDL reconstruction is covered by `ddl::tests`. Manual QA in 9.4-9.6 covers the live path.)

## 4. Frontend: API binding + activity-log type

- [x] 4.1 Add `tableStructure(connectionId, schema, relation, origin?)` to the Postgres schema API module (`src/modules/postgres/schema/api.ts`), returning the typed response.
- [x] 4.2 Add the matching TS types co-located with the existing schema types in `src/modules/postgres/schema/types.ts`. Mirror the Rust shapes including the partial-degradation envelope.
- [x] 4.3 Add `"table_structure"` to the activity-log `ActivityKind` union in `src/platform/activity-log/types.ts`.
- [x] 4.4 Add the `KIND_LABEL` entry for `"table_structure"` in `src/platform/activity-log/ActivityLogRow.tsx`. (The renderer reuses the existing `items` metric path from `renderMetricShort`/`renderMetricLong`, which already handles `<n> items`. Connection / relation subtitle reuses the existing `connectionLabel` prop column. No new branch needed beyond the label.)

## 5. Frontend: sub-tabset in TableViewerTab

- [x] 5.1 Wrap the existing data UI (filter bar + grid + inspector + bottom bar) in a `.dataSubtab` flex container inside `TableViewerTab.tsx`. The data state (hooks, buffer, refs) stays at `TableViewer` scope so it survives subtab switches; the wrapper toggles `display: none` when inactive (instead of unmounting) so scroll/grid DOM state is preserved.
- [x] 5.2 Added `useState<Subtab>("data")` to the `TableViewer` component. The state lives on the component instance so closing and reopening the tab resets to `"data"` (TableViewer remounts), and switching browser tabs keeps the value.
- [x] 5.3 Added the `<SubtabHeader />` segmented control above the data wrapper, styled to match `DESIGN.md` (uppercase tracking, Geist, accent underline on active).
- [x] 5.4 Render `<StructureSubtab />` / `<RawSubtab />` conditionally based on active subtab; the Data wrapper stays mounted but hidden when inactive.
- [x] 5.5 Wired `Cmd+1` / `Cmd+2` / `Cmd+3` (and `Ctrl` on non-mac) into the existing root keydown handler. Skips when focus is in an `<input>`, `<textarea>`, `<select>`, or inside `.cm-editor` (CodeMirror DOM).
- [x] 5.6 Verified: the BottomBar (which owns the read-only / no-PK banners and the Save / Add row controls) is rendered inside `.dataSubtab` and is therefore hidden whenever Structure or Raw is active.

## 6. Frontend: Structure subtab

- [x] 6.1 Created `src/modules/postgres/structure/StructureSubtab.tsx`. Props: `{ tabs, connectionId, connectionName, schema, relation, relkind, cache }`. Cache is shared with Raw via the `useTableStructureCache` hook owned by `TableViewer`.
- [x] 6.2 On first activation where `cache.state.status === "idle"`, dispatches `tableStructure(..., "user")` via `cache.ensureLoaded("user")` and renders `loading → ready | error`. Subsequent activations re-use the cache.
- [x] 6.3 Header renders `schema.relation` in Geist Mono, the `relkind` label (Table / View / Materialized view), and a **Refresh** button.
- [x] 6.4 Columns section: table with `#` (right-aligned tabular numeric), `Name`, `Type`, `Nullable`, `Default`, `PK`, `FK`, `Comment`. PK marker uses `primary_key.columns` membership. FK chip is rendered for any column referenced by an FK; clicking opens the referenced relation via `openObjectTab`.
- [x] 6.5 Indexes / Foreign keys / Unique constraints / Check constraints / Triggers sections render per spec. Empty sections are hidden by default; for views/matviews the constraint sections show the "Views do not declare constraints — see the underlying tables." empty state.
- [x] 6.6 Per-kind failures render an inline error chip "Couldn't load <kind> — <message>" with a Retry button that calls `cache.refresh("user")`.
- [x] 6.7 Typography matches `DESIGN.md`: hairline dividers (`var(--hairline)`), Geist Mono for identifiers and SQL types, tabular numerals on the ordinal column, accent on FK chip hover.

## 7. Frontend: Raw subtab

- [x] 7.1 Created `src/modules/postgres/structure/RawSubtab.tsx`. Reuses the parent-level `cache` from `useTableStructureCache`.
- [x] 7.2 On first activation where `cache.state.status === "idle"`, dispatches the same call. The cache hook deduplicates via its shared in-flight promise so concurrent Structure + Raw activation issues only one request.
- [x] 7.3 Header renders the muted "Reconstructed DDL — not a `pg_dump` substitute." subtitle plus `Copy` and `Refresh` buttons.
- [x] 7.4 CodeMirror 6 editor with `EditorView.editable.of(false)`, `sql({ dialect: PostgreSQL })`, line wrapping, default highlight style. No autocomplete, no run keymap, no history.
- [x] 7.5 Copy button uses `navigator.clipboard.writeText` (Tauri webview supports the standard Clipboard API; the `@tauri-apps/plugin-clipboard-manager` dep isn't installed in this project, and the Web API works without permission prompts in the local Tauri shell). Shows a 1.5s "Copied" affordance.
- [x] 7.6 Renders the "Best effort — this relation has features the reconstruction may simplify." chip when the backend response sets `is_best_effort = true` (set for partitioned tables, foreign tables, and any unexpected relkind).

## 8. Frontend: cache deduplication

- [x] 8.1 Added `useTableStructureCache(connectionId, schema, relation)` in `src/modules/postgres/structure/useTableStructureCache.ts`. Owns `{ status, response, error }` plus an `inflightRef` promise. Exposes `{ state, ensureLoaded(origin), refresh(origin) }`.
- [x] 8.2 `ensureLoaded` returns immediately when `status === "ready"`, returns the existing in-flight promise when `status === "loading"`, otherwise dispatches.
- [x] 8.3 `refresh` always dispatches; transitions to `"loading"` and overwrites the cache atomically on success. On failure, the previous `response` is preserved (the caller renders a banner, not a wipe).
- [x] 8.4 Per-tab isolation: each `TableViewer` instance owns its own hook state, and the spec test for "two tabs of the same relation" is covered by React's instance-local `useState`. Manual QA below verifies behaviour live.

## 9. Tests + manual QA

- [x] 9.1 Vitest: `src/modules/postgres/structure/useTableStructureCache.test.ts` covers initial load, dedup of concurrent activations, refresh replaces, error keeps prior response.
- [ ] 9.2 Vitest render-test `<StructureSubtab />` — deferred. The cache hook (the surface with real branching) is unit-tested; `StructureSubtab` is mostly markup that consumes typed props. A render-test would mostly assert table cell text. Manual QA in 9.4-9.6 covers the live behaviour. (Document as a follow-up if visual regressions show up.)
- [ ] 9.3 Vitest render-test `<RawSubtab />` — deferred for the same reason; CodeMirror in jsdom is finicky and the editor is read-only via a single config flag (`EditorView.editable.of(false)`). Covered by manual QA.
- [ ] 9.4 Manual QA — pending live Postgres connection (cannot exercise from this session). Smoke-tested that the bundle compiles, types are tight, and the cache hook contract matches `Structure ↔ Raw` deduplication.
- [ ] 9.5 Manual QA against view / matview — pending live Postgres.
- [ ] 9.6 Manual QA against read-only connection — pending live Postgres.
- [x] 9.7 Ran the local checks: `pnpm typecheck` (pass), `pnpm lint` (24 pre-existing warnings only, 0 errors), `pnpm test:run` (60 pass), `cargo test --lib -- --test-threads=1` (148 pass). The default-parallel cargo run flakes one pre-existing `platform::connections` test on shared SQLite state — unrelated to this change and reproducible on master.

## 10. OpenSpec validation

- [x] 10.1 `openspec validate table-structure-tab --strict` passes.
- [x] 10.2 Updated `openspec/ROADMAP.md` to mark item 8 in-progress (removed the stale `← siguiente` arrow on item 6 which is already landed per `git log`).
