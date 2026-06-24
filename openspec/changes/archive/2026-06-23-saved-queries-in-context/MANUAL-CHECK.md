# Manual verification steps

Automated coverage (all passing): frontend typecheck, `vitest` (saved-queries +
context + engine SQL editors), Rust `cargo check` + `cargo test --lib context`
(198 tests), and `openspec validate --strict`.

The following require driving the Tauri GUI and must be run interactively
(`pnpm tauri:dev`). They close issues #180 and #181.

## #181 — Saved Queries panel reappears
1. Open a connection so the **workspace** window opens.
2. Confirm the sidebar shows the **Saved Queries** panel below the connection tree.
3. If the local `argus.db` already has saved queries, confirm they render (not the
   empty state). With none, confirm the explicit empty state shows.

## #180 — Queries live in the context folder, shared across workspaces
1. Link a Postgres connection to a context folder (Connection form → context folder).
2. In a Postgres SQL editor, write SQL → **Save query** → give it a name.
   - Confirm the file pair appears on disk: `<root>/postgres/queries/<slug>.sql`
     and `<slug>.meta.yaml`.
   - Confirm **no** new row was inserted into the local `saved_queries` table
     (`sqlite3 ~/Library/Application\ Support/com.argus.app/argus.db
     'select count(*) from saved_queries'` before/after).
3. Confirm the query now appears in the Saved Queries panel under a
   **Context Queries** group (project → engine), alongside any legacy local queries.
4. Open a **second** workspace/checkout whose connection links the **same** context
   folder → confirm the query appears there too (shared by repo folder).
5. Right-click the context query → **Rename** and **Delete**; confirm the file pair
   is renamed/removed on disk and the panel updates live (filesystem watcher).
6. Confirm legacy local saved queries still open and run from the panel.
