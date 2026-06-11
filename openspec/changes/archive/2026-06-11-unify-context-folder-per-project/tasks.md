## 1. Idempotent create-or-link (`context_create_folder`)

- [x] 1.1 In `src-tauri/src/modules/context/commands.rs`, replace the blanket "directory not empty" guard in `context_create_folder`: when the directory exists, attempt `parser::parse_manifest`; on success, return the canonical path without rewriting `context.yaml`/`README.md`/`.gitignore` or touching any object docs/queries.
- [x] 1.2 Keep the missing-directory branch unchanged (scaffold `context.yaml` with `name` + `schema_version: 1`, `README.md`, `.gitignore`).
- [x] 1.3 Preserve the validation error for a non-empty directory whose `context.yaml` is missing or unparseable (foreign directory case).
- [x] 1.4 Add Rust unit tests covering the three branches: fresh path scaffolds; existing valid folder is returned untouched (assert scaffold files unchanged byte-for-byte); non-empty foreign directory errors.

## 2. Known-folder discovery command

- [x] 2.1 Add a `context_list_known_folders` Tauri command (in `src-tauri/src/modules/context/commands.rs`) plus a small result type (canonical `path`, manifest `name`, `connection_ids: Vec<...>`).
- [x] 2.2 Source the distinct non-null `context_path` values from saved connections via `platform/connections.rs`; canonicalize each with `std::fs::canonicalize` and collapse duplicates by canonical path (matching the registry's keying).
- [x] 2.3 For each surviving root, parse `context.yaml` for the display name and attach the ids of all connections resolving to that canonical root; omit roots that no longer exist on disk or whose manifest fails to parse.
- [x] 2.4 Ensure group membership is ignored entirely (no `group_id` filtering); a root shared by connections in different groups returns one entry listing all of them.
- [x] 2.5 Register the command in the Tauri `invoke_handler` (alongside the other `context_*` commands).
- [x] 2.6 Add Rust unit tests: two connections sharing a canonical root collapse to one entry with both ids; stale/non-existent path omitted; no linked folders returns empty; cross-group sharing returns a single entry.

## 3. Frontend reuse-first flow

- [x] 3.1 In the context-folder link/setup UI, call `context_list_known_folders` and present existing folders (name + path) as the primary choice, with "create new folder" as the secondary action.
- [x] 3.2 When the user picks an existing folder, link it via the existing link path (selecting it should subscribe the connection to that root).
- [x] 3.3 Verify the create-new path now succeeds when the chosen directory is already a valid context folder (idempotent), with no error dialog.

## 4. Docs

- [x] 4.1 Update `README.md` "Context folders" to describe the one-folder-per-project model and the reuse-first flow (multiple connections, one shared root).
- [x] 4.2 Update root `CLAUDE.md` "Context folders" summary to state that a folder is shareable across connections of any engine and is independent of connection groups.
- [x] 4.3 Update GitHub issue #96 to reflect the re-scope (share-one-root-by-default, not flatten-the-layout) and link this change.

## 5. Validation

- [x] 5.1 Run `cargo test` for the context module and confirm new tests pass.
- [x] 5.2 Run `openspec validate unify-context-folder-per-project --strict` and resolve any findings.
- [x] 5.3 Manually verify end-to-end: create a folder for connection A, then for connections B and C (different engines) reuse the same root from the picker; confirm one `~/project/` with `postgres/`, `dynamo/`, `athena/` subtrees and a single filesystem watcher. _(Verified manually by the user.)_
