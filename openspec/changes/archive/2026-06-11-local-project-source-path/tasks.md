## 1. Database schema

- [x] 1.1 Add migration `src-tauri/migrations/0007_project_source.sql` with `ALTER TABLE connections ADD COLUMN project_source_path TEXT`
- [x] 1.2 Register the new migration in the embedded migrations array in `src-tauri/src/platform/storage.rs`

## 2. Connection model & persistence

- [x] 2.1 Add `project_source_path: Option<String>` to `Connection` in `src-tauri/src/platform/connections.rs`
- [x] 2.2 Add `#[serde(default)] project_source_path: Option<String>` to `ConnectionInput`
- [x] 2.3 Add triple-state `project_source_path: Option<Option<String>>` to `ConnectionUpdate` with a `deserialize_project_source_path_field` deserializer mirroring `deserialize_context_path_field`
- [x] 2.4 Update `create` INSERT to write the new column and include it in the returned `Connection`
- [x] 2.5 Update `update` to apply triple-state semantics (omit = unchanged, `Some(None)` = clear, `Some(Some)` = set) and persist the column
- [x] 2.6 Update every row→`Connection` mapping (list/fetch/SELECT column lists) to read `project_source_path`

## 3. Resolution & migration helper

- [x] 3.1 In `src-tauri/src/modules/context/commands.rs`, add `resolve_project_source_path(db, conn_id) -> AppResult<Option<String>>`: return the DB column if set; else read legacy `project_source_path` from the linked folder's `context.yaml`, write it into the DB column, strip it from `context.yaml` via `write_project_source_path(root, None)`, and return it; else `None`
- [x] 3.2 Keep `read_project_source_path` (legacy read) and `write_project_source_path(root, None)` (strip); remove any `write_project_source_path(root, Some(..))` call site

## 4. Tauri commands

- [x] 4.1 Reimplement `context_get_project_source(db, connection_id)` to return `resolve_project_source_path(...)` (drop the "no linked context folder" precondition)
- [x] 4.2 Reimplement `context_set_project_source(db, connection_id, path)` to persist the path to the connection record via `connections::update` (drop the "no linked context folder" precondition); ensure no write to `context.yaml`

## 5. AI inspector

- [x] 5.1 In `src-tauri/src/modules/ai/commands.rs`, change `ai_inspect_models` to obtain the path via `resolve_project_source_path(...)` instead of `read_project_source_path(root)`; keep the validation error when unset and keep requiring a linked folder for table docs

## 6. Tests

- [x] 6.1 Add `connections.rs` CRUD tests for `project_source_path` (set on create, triple-state update: unchanged / clear / replace) mirroring the `context_path` tests
- [x] 6.2 Add a test that `resolve_project_source_path` returns the DB value when set and ignores `context.yaml`
- [x] 6.3 Add a migration test: connection with empty DB value and a legacy `project_source_path` in `context.yaml` → resolve returns it, DB column is populated, and `context.yaml` loses the key while keeping `schema_version`/`name`/other extras
- [x] 6.4 Add/adjust `context_get_project_source` / `context_set_project_source` command tests to reflect DB-backed behavior and the dropped folder precondition

## 7. Docs

- [x] 7.1 Update `README.md` AI providers section: describe `project_source_path` as local per-connection state set via the inspector picker, no longer a `context.yaml` key; note that existing committed values are migrated and stripped on first use
- [x] 7.2 Reconcile the unarchived `dynamo-model-ai-inspector` change's `connection-context-folders` delta spec (or coordinate archive order) so the baseline reflects local storage

## 8. Verification

- [x] 8.1 Run `cargo test` in `src-tauri` and confirm all new and existing tests pass
- [x] 8.2 Run `openspec validate local-project-source-path --strict` and resolve any issues
