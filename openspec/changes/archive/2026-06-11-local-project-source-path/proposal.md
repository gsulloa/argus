## Why

The DynamoDB AI model inspector needs to know where the user's application source repo lives, and today that path is stored as `project_source_path` inside the context folder's `context.yaml` — a file meant to be committed and shared. An absolute, machine-specific path like `/Users/gabrielulloa/dev/meki/backend` does not belong in a shared artifact: it breaks for every teammate who checks the folder out, produces noisy per-machine git diffs, and leaks a user's local directory layout. The path is inherently a local, per-machine concern and should live in local storage, exactly like the connection's `context_path` already does.

## What Changes

- Move `project_source_path` from the shared `context.yaml` to a local, per-connection field stored in the app's SQLite database (`connections` table), mirroring the existing `context_path` column.
- The `context_get_project_source` / `context_set_project_source` Tauri commands keep their names and signatures but read/write the per-connection DB field instead of `context.yaml`. The "connection must have a linked context folder" precondition is dropped for read/write (the value is now a plain connection field); the inspector flow still independently requires both a linked folder and a configured source path.
- `ai_inspect_models` reads the source path from the connection record instead of `context.yaml`.
- One-time, lazy migration: the first time the source path is resolved for a connection whose DB field is empty, if its linked `context.yaml` carries a legacy `project_source_path`, the value is copied into the DB field **and removed from `context.yaml`** so committed folders stop carrying it. No DB-row migration is needed for the path value itself.
- Add a `connections.project_source_path` column via a new SQL migration; extend the `Connection` / `ConnectionInput` / `ConnectionUpdate` structs (triple-state update like `context_path`).
- Update `README.md` (AI providers section) to document the path as local per-connection state, not a `context.yaml` key.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `connection-context-folders`: the `project_source_path` is stored as a local per-connection field (SQLite), not in the shared `context.yaml`; read/write commands operate on the connection record; a one-time lazy migration relocates any legacy value out of `context.yaml`.

## Impact

- **Code (Rust):**
  - `src-tauri/migrations/` — new `0007_project_source.sql` (`ALTER TABLE connections ADD COLUMN project_source_path TEXT`).
  - `src-tauri/src/platform/connections.rs` — add `project_source_path` to `Connection`, `ConnectionInput`, `ConnectionUpdate`; update INSERT/UPDATE/SELECT and mapping.
  - `src-tauri/src/modules/context/commands.rs` — reimplement `context_get_project_source` / `context_set_project_source` against the DB; add a shared `resolve_project_source_path(db, conn_id)` helper that performs the lazy legacy migration; retain `read_project_source_path` / `write_project_source_path(root, None)` only as legacy read + strip helpers.
  - `src-tauri/src/modules/ai/commands.rs` — `ai_inspect_models` resolves the path from the connection record via the shared helper.
- **Frontend:** no signature changes for `getProjectSource` / `setProjectSource` (`src/modules/dynamo/data-view/api.ts`); behavior is transparent.
- **Docs:** `README.md` AI providers section; `docs/context-folder-example/` already omits the key (no change expected).
- **Dependency / ordering:** the `project_source_path`-in-`context.yaml` requirement currently lives in the **unarchived** `dynamo-model-ai-inspector` change. This change supersedes that storage decision; the inspector change's delta spec for `connection-context-folders` should be reconciled (or this change archived after it) so the baseline reflects local storage.
- **No breaking change for end users:** existing folders with a committed `project_source_path` are migrated automatically on first resolve.
