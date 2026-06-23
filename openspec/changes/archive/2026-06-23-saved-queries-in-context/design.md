## Context

Argus has **two independent query systems** today:

1. **Saved Queries** — local SQLite (`saved_queries` + `saved_query_folders` in
   `argus.db`), CRUD via `saved_queries_*` Tauri commands, rendered by the global
   `SavedQueriesPanel` in the sidebar (between Connections and Plataforma).
   Supports nested folders. The DB lives at
   `~/Library/Application Support/com.argus.app/argus.db` and is **shared across
   all Conductor workspaces** (the bundle id `com.argus.app` and `DB_FILENAME
   = "argus.db"` have been constant — confirmed via git history). So local saved
   queries persist across workspaces; the "they disappeared" symptom (#181) is a
   **load/render regression**, not storage relocation.

2. **Context (prefab) queries** — files in the per-repo **context folder**:
   `<root>/<engine>/queries/<name>.<ext>` + `<name>.meta.yaml`
   (`ext` = `sql` for PG/MySQL/MSSQL, `partiql` for Dynamo, `cwlogs` for
   CloudWatch). Parsed by `modules/context/parser.rs::parse_queries_dir`, listed
   read-only via `context_list_queries` / `context_get_query`, surfaced per
   connection in the `ContextQueriesBranch`, and runnable
   (`context-queries-runner`). **The queries dir is currently READ-ONLY** — only
   schema/object docs and Dynamo models are ever written (`context_save_model`,
   `context_sync_schema`). The watcher emits `context://changed` with
   `kinds:["query"]` on changes under `queries/`.

The user wants these unified: one panel showing **both** sources, with **all new
queries written to the context folder** so they are shared across every
workspace/project linked to the same repo (the guiding model: "the context folder
is the project").

Relevant code: `modules/saved_queries/` (Rust), `modules/saved-queries/` (TS),
`modules/context/{commands,parser,sync,registry,types}.rs`,
`modules/context/{api.ts,hooks.ts,components/ContextQueriesBranch.tsx}`,
`platform/shell/Sidebar.tsx`, `app/App.tsx` (bootstrap).

## Goals / Non-Goals

**Goals:**
- Saved Queries panel shows entries again (fix #181) and never loses existing
  local-DB queries.
- The panel renders **both** local-DB queries and context-folder queries in one
  place, each clearly labeled by source/project.
- New queries are authored **into the context folder** (write side), with live
  propagation through the existing `context://changed` watcher.
- Context queries remain runnable (parameters, open-in-editor) from the unified
  panel, identical to the per-connection branch behavior.

**Non-Goals:**
- Auto-migrating existing local-DB queries into context folders (they stay
  visible/editable in place; a future "Move to context" action is out of scope).
- Subfolder/nesting support for context queries (context format is flat per
  engine; only legacy local-DB queries keep their folder tree).
- Removing the local `saved_queries` table or its migration (kept for backward
  compatibility).
- Git versioning/sync mechanics — files land on disk; the user commits if desired.

## Decisions

### Decision 1 — Keep local DB as read/edit legacy; route all creation to context
New `New query` / `Save query` actions write context files only. Existing local
rows remain listed and remain editable/deletable via the existing `saved_queries_*`
commands (so nothing is lost), but no new local rows are ever inserted.
*Alternative considered:* hard-migrate local → context on first run. Rejected for
v1 — risky (which engine/folder?), and the user only asked that old ones remain
visible, not relocated.

### Decision 2 — Target context folder resolution for new queries
Context queries are scoped to a **context root + engine**. The global panel
resolves a write target as:
- **Save from SQL editor:** use the active editor tab's connection → its
  `context_path` (canonicalized) + engine subtree. Unambiguous, no prompt.
- **Panel `+` at a context-project group:** create in that group's root/engine.
- **Panel `+` at top level:** if exactly one linked context folder exists,
  default to it; if multiple, open a small picker (connection/folder + engine);
  if none linked, show a CTA to link/create a context folder first.

### Decision 3 — Aggregate listing command, dedupe by canonical path
Add `context_list_linked_queries()` (Rust) that enumerates connections with a
non-null `context_path`, canonicalizes paths, dedupes shared roots, and returns
**groups** `{ canonical_root, display_name, engine, representative_connection_id,
queries: QueryListItem[] }`. This avoids N frontend IPC calls and centralizes
dedupe (two connections sharing a folder list once). The representative
connection id is used for run/open (parameter substitution needs a live
connection). *Alternative:* iterate `context_list_queries` per connection in TS.
Rejected — duplicates the dedupe logic in the client and multiplies IPC.

### Decision 4 — Source-tagged unified tree
Each panel node carries `source: "local" | "context"`. Context nodes also carry
`{ canonicalRoot, projectName, engine, representativeConnectionId, queryName }`.
The tree renders local-DB queries (with their folder hierarchy) and, below/among
them, context queries grouped by **project (context folder) → engine**, with a
source badge so the two never look like duplicates. Dedupe context entries by
`(canonicalRoot, engine, name)`.

### Decision 5 — Authoring commands mirror the model-doc pattern
Add to `modules/context/commands.rs`, registered in `lib.rs`:
- `context_save_query({ connection_id, name, sql, description?, params?, tags? })`
  → derive a filesystem-safe slug from `name`, write
  `<root>/<engine>/queries/<slug>.<ext>` + `<slug>.meta.yaml`, return the saved
  `QueryDoc`. Creates the `queries/` dir if missing. On an existing slug for a
  *create*, return a structured `Conflict` error; *update* (same slug) overwrites.
- `context_rename_query({ connection_id, from_name, to_name })` → rename both
  sibling files; reject if target exists.
- `context_delete_query({ connection_id, name })` → remove both sibling files.
All reuse the engine→ext + path derivation already in `parser.rs`/`sync.rs`, and
all rely on the existing watcher to emit `context://changed kinds:["query"]`
(the command may also emit proactively to avoid debounce lag). Meta is written as
YAML matching `QueryMeta` ({name, description, params, tags}); a body-only write
(no meta needed) is valid per the existing "without meta file" requirement, but we
always write meta to preserve the display name.

### Decision 6 — Regression fix (#181), evidence-driven
The panel renders unconditionally (`Sidebar.tsx:60`) and bootstraps via
`SavedQueriesBootstrap` → `savedQueriesStore.loadAll()` (`App.tsx`). Implementation
begins with a **diagnosis step**: confirm `saved_queries_list` returns rows
against the shared `argus.db`, that `loadAll()` runs in the current (post
dedicated-windows refactor #175/#177) window/shell, and that `buildTree` +
`SidebarTree` render them (vs. an empty-state mask or swallowed error). Fix the
identified break, then add a regression test (store/tree unit test asserting
non-empty list renders) and a documented manual check.

## Risks / Trade-offs

- **[Slug collisions / non-ASCII names]** → Derive a deterministic
  filesystem-safe slug; on create-conflict return a clear `Conflict` error rather
  than silently overwriting; keep the human-readable `name` in `meta.yaml`.
- **[Watcher race: write then stale list]** → Authoring commands return the saved
  `QueryDoc` and the frontend updates optimistically; the `context://changed`
  event reconciles. Idempotent re-read on event.
- **[No context folder linked when user hits "New query"]** → CTA to
  link/create a folder; do not silently fall back to a local-DB row (would violate
  the "always context" requirement).
- **[Two connections, divergent paths to same folder]** → Canonicalize (resolve
  symlinks, strip trailing slash) before dedupe, reusing the existing canonical
  path logic from `connection-context-folders`.
- **[Perceived duplication local vs context]** → Source badges + grouping;
  document that old queries stay local until manually recreated/moved.
- **[Regression root cause not reproducible in-repo]** → Diagnosis step is
  explicit in tasks; the merge work re-exercises the load path regardless, and a
  unit test guards the render-non-empty contract going forward.

## Migration Plan

- No DB migration. `saved_queries` table retained; existing rows keep rendering.
- Ship backend authoring commands + aggregate list command, then frontend
  unification. Feature is additive; rollback = revert the frontend merge and the
  new commands (local DB path is untouched).
- Update `README.md` "Context folders" and `docs/context-folder-example/` to
  document query authoring.

## Open Questions

- Should the top-level `+` picker also allow choosing the engine explicitly, or
  always infer from the chosen connection? (Lean: infer from connection.)
- Should context-query grouping be by project-folder name or by connection name
  when names collide? (Lean: project folder `context.yaml` `name`, fall back to
  folder basename.)
- Long-term: offer a one-click "Move local query → context" migration? (Deferred.)
