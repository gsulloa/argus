## Why

A user with one project spanning RDS (Postgres), DynamoDB, and Athena ends up
with **three separate context folders** — one per connection — each containing a
single redundant engine subtree (`~/proj-rds/postgres/`, `~/proj-dynamo/dynamo/`,
`~/proj-athena/athena/`). The data model already supports sharing one root across
connections (each connection stores its own `context_path`; the registry dedupes
the watcher by canonical path), but the UI funnels users into **creating** a new
folder per connection instead of **reusing** an existing one. The result is a
fragmented, over-nested layout that is hard to organize.

The fix is not to flatten the on-disk layout — the `<engine>/<schema>/` nesting is
correct and stops being redundant the moment one root holds all of a project's
engines. The fix is to make **sharing one root the path of least resistance**, so
"one folder per project" is the natural outcome. Nobody depends on the current
flow yet, so we can change it cleanly.

## What Changes

- **`context_create_folder` stops treating a populated folder as an error when it
  already holds a valid `context.yaml`.** Today it returns `"directory not empty"`
  for any non-empty directory, which blocks pointing a second/third connection at
  a folder a sibling connection already initialized. It will instead treat an
  existing valid context folder as a successful link (idempotent), and only error
  on a non-empty directory that is *not* a context folder.
- **New discovery command lists the context folders already known to the app**, so
  the link/setup UI can offer "reuse an existing folder" instead of defaulting to
  "create new". The list is derived from the distinct, still-existing
  `context_path` values across saved connections (each annotated with its
  `context.yaml` name and the connections already attached).
- **Establish "the context folder is the project" as the guiding model** in spec
  language: a project is the set of connections pointing at the same canonical
  root; the project name lives in `context.yaml`. No new project/group entity is
  introduced, and the folder is **not** coupled to `connection-groups` — a
  connection retains its `context_path` regardless of group membership.
- The on-disk layout (`<root>/<engine>/<schema>/<object>.md`, Dynamo
  `tables/`, CloudWatch `groups/`) is **unchanged**. No flattening of the engine or
  schema levels.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `connection-context-folders`: add requirements for (1) idempotent
  create-or-link behavior when targeting an existing valid context folder, and
  (2) a "list known context folders" discovery command that surfaces reusable
  roots with their manifest name and attached connections.

## Impact

- **Rust commands** (`src-tauri/src/modules/context/commands.rs`):
  - `context_create_folder` — relax the non-empty guard to detect and accept an
    existing valid `context.yaml` (idempotent link), keep erroring on foreign
    non-empty directories.
  - New command (e.g. `context_list_known_folders`) reading distinct
    `context_path` values via `platform/connections.rs` and parsing each
    manifest (`parser::parse_manifest`) for the folder name; skip paths that no
    longer exist on disk.
- **No schema/data-model change.** `context_path` stays on the connection
  (`platform/connections.rs`); sharing remains by canonical path, deduped by the
  existing `ContextRegistry` watcher.
- **Frontend** (context-folder link/setup UI): present known folders as the
  primary choice with "create new" as the secondary path. (UI wiring tracked in
  tasks; spec scope is the backend contract.)
- **Docs**: `README.md` "Context folders" and `CLAUDE.md` to describe the
  one-folder-per-project model and the reuse-first flow.
- Relates to GitHub issue #96 (re-scoped from "flatten the layout" to "make
  sharing one root the default").
