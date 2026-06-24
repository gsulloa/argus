## Why

Saved queries today live only in the local SQLite database (`saved_queries` /
`saved_query_folders` tables). Two problems follow from that:

1. **They are not shared across projects of the same repo (issue #180).** Useful
   inspection/debug queries are trapped in one machine's app DB. The team already
   keeps engine documentation in a per-repo **context folder** ("the context
   folder is the project"); queries belong there too so every workspace/project
   that links the same folder sees the same queries.
2. **They stopped appearing (issue #181).** The "Saved Queries" sidebar panel is
   no longer surfacing entries, which reads as data loss. The local DB is global
   (bundle id `com.argus.app`, `argus.db`) and stable across workspaces, so the
   regression is in the load/render path, not in storage relocation.

The user's intent unifies both: in any workspace the panel must show **both** the
previously-saved local queries **and** the context-folder queries, and **every new
query must be saved into the context folder** — no new local-DB rows.

## What Changes

- **Fix the regression (issue #181):** diagnose and repair why the Saved Queries
  panel stopped rendering entries; guarantee existing local-DB queries remain
  visible and are never lost by this change. Add a regression test / documented
  manual check.
- **Surface context-folder queries in the Saved Queries panel:** the panel
  aggregates queries from every linked context folder (parsed from
  `<root>/<engine>/queries/<name>.<ext>` + `<name>.meta.yaml`) alongside legacy
  local-DB queries, deduped by canonical context path, each tagged with its
  source (Local vs. Context / which project folder).
- **Author queries into the context folder (issue #180):** new backend commands
  to create, rename, edit, and delete prefab query files in a connection's
  context folder (mirroring the existing `context_save_model` / `context_delete_model`
  pattern), wired through the file watcher so changes propagate live via
  `context://changed` (`kinds: ["query"]`).
- **Route creation to the context folder:** "Save query" from the SQL editor and
  the panel's "+" action write to the context folder of the active/selected
  connection. **BREAKING (behavioral):** new queries are no longer written to the
  local `saved_queries` table. Existing local-DB queries stay visible and
  editable in place; when no context folder is linked, creation guides the user
  to link/create one first.
- **Keep context queries runnable** from the unified panel exactly as they are
  today from the per-connection "Context Queries" branch (parameter substitution,
  open-in-editor).

## Capabilities

### New Capabilities
- `context-query-authoring`: backend commands and UI flow to create, rename,
  edit, and delete prefab query files (`<engine>/queries/<name>.<ext>` +
  `<name>.meta.yaml`) inside a connection's linked context folder, with live
  propagation through the context registry/watcher. This is the write side that
  complements the existing read-only `context-queries-runner`.

### Modified Capabilities
- `saved-queries`: the Saved Queries panel becomes source-aware — it renders both
  legacy local-DB queries and context-folder queries in one tree with source
  labels, fixes the regression where entries stopped showing, and routes new
  query creation to the context folder instead of inserting local-DB rows.
- `context-queries-runner`: context queries are additionally surfaced and run
  from the unified Saved Queries panel (not only the per-connection branch), and
  reflect authoring changes live.

## Impact

- **Rust backend:**
  - `modules/context/` — new query-authoring commands in `commands.rs` (write
    `<engine>/queries/*.sql|partiql|cwlogs` + `*.meta.yaml`), reusing path
    derivation from `parser.rs`/`sync.rs` and emitting via `registry.rs`
    (`context://changed`, `kinds:["query"]`). Possible aggregate-list command for
    cross-connection query listing.
  - `modules/saved_queries/` — no schema change; loading path reviewed for the
    regression. `lib.rs` command registration for the new commands.
- **Frontend (`packages/app/src`):**
  - `modules/saved-queries/` — `SavedQueriesPanel.tsx`, `store.ts`, `api.ts`,
    `useSavedQueries.ts`, `types.ts`: merge two sources, source badges, route
    creation to context, regression fix in load/render.
  - `modules/context/` — `api.ts`/`hooks.ts` gain authoring calls; reuse
    `useContextQueries` / `context://changed` listeners.
  - SQL editor "Save query" entry point (Postgres + other engines' editors).
- **Specs:** new `context-query-authoring`; deltas to `saved-queries` and
  `context-queries-runner`.
- **No DB migration.** Local `saved_queries` table is retained for backward
  compatibility (existing rows remain visible). No credentials or connection
  secrets are written to disk — only SQL text + metadata.
- **Docs:** `README.md` "Context folders" and `docs/context-folder-example/`
  query authoring note.
