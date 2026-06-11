## Context

The DynamoDB AI model inspector (`ai_inspect_models`) needs the absolute path to the user's application source repo so the CLI provider (Claude/Codex) can scan it for entity definitions. Today that path is `project_source_path`, stored in the context folder's `context.yaml` under `ContextManifest.extras` (a forward-compatible flatten map). That requirement was introduced by the still-unarchived `dynamo-model-ai-inspector` change.

`context.yaml` is, by the project's "the context folder is the project" model, meant to be committed to git and shared across machines and teammates. An absolute path (`/Users/gabrielulloa/dev/meki/backend`) is the opposite of shareable: it's per-machine, per-user, leaks local directory structure, and creates noisy diffs.

The codebase already solves the "per-connection local config" problem for `context_path`: it's a nullable `TEXT` column on the SQLite `connections` table (added in migration `0005`), surfaced on the `Connection` struct, set on create, and updated with triple-state (`Option<Option<String>>`) semantics. The database lives in the OS app-data dir and is never committed. `project_source_path` is the same shape of data and should follow the same pattern.

Relevant code:
- `src-tauri/src/platform/connections.rs` — `Connection`, `ConnectionInput`, `ConnectionUpdate`, create/update/list, `context_path` triple-state deserializer.
- `src-tauri/migrations/0005_connection_context.sql` — `ALTER TABLE connections ADD COLUMN context_path TEXT`.
- `src-tauri/src/modules/context/commands.rs` — `PROJECT_SOURCE_PATH_KEY`, `read_/write_project_source_path`, `context_get_/set_project_source`.
- `src-tauri/src/modules/ai/commands.rs` — `ai_inspect_models` (resolves the path before spawning the inspector).
- `src/modules/dynamo/data-view/api.ts` + `DataViewTab.tsx` — frontend `getProjectSource` / `setProjectSource` and the "select your application source repo" picker.

## Goals / Non-Goals

**Goals:**
- Store `project_source_path` as local, per-connection state that is never written to a shared/committed file.
- Keep the frontend API (`getProjectSource` / `setProjectSource`) unchanged so the UI is unaffected.
- Migrate existing folders transparently: any `project_source_path` already committed in a `context.yaml` is relocated to local storage and stripped from the file on first use.
- Match the established `context_path` per-connection storage pattern (column + struct fields + triple-state update).

**Non-Goals:**
- Changing the inspector's behavior, prompt, or provider plumbing.
- Reworking the context-folder format generally, or migrating any other `context.yaml` extras.
- Adding a UI for editing the source path beyond the existing picker flow.
- A standalone batch/startup migration pass over all folders (the lazy on-resolve migration covers it without scanning the disk).

## Decisions

### D1: Store as a per-connection SQLite column, not in `context.yaml`
Add `project_source_path TEXT` (nullable) to the `connections` table via migration `0007_project_source.sql`, and add `project_source_path: Option<String>` to `Connection`, `ConnectionInput`, and `ConnectionUpdate` (the last with the triple-state `deserialize_*_field` pattern used for `context_path`). Wire it through `create` (INSERT), `update` (UPDATE), and the row→struct mapping in `list`/fetch.

*Why:* This is the exact pattern already proven for `context_path`. The DB is local and uncommitted, killing the git-friendliness problem at the root. Per-connection (rather than per-folder) is consistent — `context_path` itself is already per-connection even though the folder is "the project," so each connection independently records both its folder and its source repo.

*Alternatives considered:*
- **Relative path / `~` expansion in `context.yaml`** — still assumes every teammate's local layout matches; only reduces, doesn't remove, the problem.
- **`context.local.yaml` sidecar (gitignored)** — introduces a second file format and a new parse/write path keyed by folder, more surface area than reusing the existing column pattern.
- **Keep in `context.yaml` + `.gitignore` the key** — impossible; you can't gitignore a key within a tracked file.

### D2: Keep command names/signatures; change only the backing store
`context_get_project_source(connection_id) -> Option<String>` and `context_set_project_source(connection_id, path)` keep their names and signatures but operate on the connection's DB field. The current precondition "connection must have a linked context folder" is **dropped** for get/set, since the value is now a plain connection field independent of any folder.

*Why:* The frontend (`api.ts`, `DataViewTab.tsx`) keeps working with zero changes. Dropping the folder precondition is harmless: the inspector flow still independently checks for both a linked folder (for table docs) and a configured source path.

### D3: Lazy, on-resolve legacy migration
Introduce a shared helper `resolve_project_source_path(db, conn_id) -> AppResult<Option<String>>` used by both `context_get_project_source` and `ai_inspect_models`:
1. Read the connection's DB column. If `Some`, return it.
2. If `None` and the connection has a `context_path`, read legacy `project_source_path` from that folder's `context.yaml`.
3. If a legacy value exists, write it into the DB column **and** strip the key from `context.yaml` (via the retained `write_project_source_path(root, None)`), then return it.
4. Otherwise return `None`.

*Why:* Existing users who already committed a path keep working without re-selecting it, and the act of using it cleans the committed value out of the shared file — the migration is self-completing and needs no disk scan or DB row migration. Putting the logic in a shared helper (not only in `get`) guarantees migration fires even if the user goes straight to the inspector without opening settings.

*Alternatives considered:* a startup batch pass over all known folders — more code, must enumerate folders, and races with the watcher; lazy resolve is simpler and sufficient.

### D4: Retain `read_/write_project_source_path` only as legacy helpers
Keep `read_project_source_path` (legacy read) and `write_project_source_path(root, None)` (strip) for the migration path; remove the `Some(path)` write call sites. `PROJECT_SOURCE_PATH_KEY` stays as the key name used during stripping.

*Why:* Minimizes deletion churn and keeps the strip operation correct (preserves `schema_version`, `name`, other extras).

## Risks / Trade-offs

- **Per-connection instead of per-folder** → Two connections sharing one folder must each set their source path once. Mitigation: the inspector's existing picker already prompts when unset, so the cost is a one-time second selection; this matches how `context_path` already behaves per-connection.
- **Lazy migration mutates a tracked file** (`context.yaml`) on first resolve → a user may see an unexpected git diff (the key removed). Mitigation: this is the intended outcome (de-committing the local path); document it in `README.md`, and the write is atomic and preserves all other fields.
- **Ordering vs the unarchived `dynamo-model-ai-inspector` change** → its delta spec still declares the `context.yaml` storage. Mitigation: documented in the proposal; reconcile the inspector change's `connection-context-folders` delta (or archive this change after it) so the baseline ends consistent. The new spec delta here is written as ADDED requirements describing the local-storage end state.
- **Inspector resolution path change** → `ai_inspect_models` must call the shared helper, not `read_project_source_path` directly. Mitigation: covered by a unit test asserting resolution from the DB column and from a legacy folder.
