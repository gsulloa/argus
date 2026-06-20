## 1. Parser: string-based entrypoint

- [x] 1.1 Extract `pub fn parse_object_doc_str(raw: &str, source_path: &Path) -> Result<ObjectDoc, ParserError>` from `parse_object_doc` in `parser.rs`; make `parse_object_doc` read the file and delegate.
- [x] 1.2 Add a unit test that `parse_object_doc_str` parses a valid in-memory doc and that CRLF input fails (proving the caller must normalize first).

## 2. Report types (Rust + IPC)

- [x] 2.1 In `types.rs` add `struct UpdatedObject { path: PathBuf, changes: Vec<String> }` (Serialize/Deserialize).
- [x] 2.2 Change `SyncReport.updated: Vec<PathBuf>` → `Vec<UpdatedObject>` and add `unchanged: usize` (`#[serde(default)]`).

## 3. Sync core: equality + diff helpers

- [x] 3.1 Add `fn system_block_unchanged(existing: &ObjectSystem, shape: &ObjectShape) -> bool` comparing kind, schema, name, primary_key (empty↔None normalized), and columns as ordered `(name, ty)` (ignoring column extras); excluding last_synced/deleted_in_db/extras/access_patterns/physical_table.
- [x] 3.2 Add `fn diff_system(old: &ObjectSystem, shape: &ObjectShape) -> Vec<String>` producing change strings: added/removed column, `type of {n}: {old} → {new}`, `primary key changed`, and `column order changed` (only when no add/remove/type change already accounts for it).
- [x] 3.3 Unit-test both helpers across: identical, added col, removed col, type change, PK change, reorder-only, empty-vs-None PK.

## 4. Sync core: diff-aware UPDATE branch

- [x] 4.1 In `execute_sync` UPDATE branch (`sync.rs:824`): when `doc_opt` is `Some`, `file_path == canonical_target`, `system_block_unchanged(...)` is true, and `deleted_in_db != Some(true)` → increment `unchanged`, run orphan detection, and `continue` (no write).
- [x] 4.2 On the rewrite path, build the `changes` via `diff_system` and push `UpdatedObject { path, changes }` to `updated` (instead of a bare path).
- [x] 4.3 Ensure relocation cases (D3/D6: legacy-flat or physical-named Dynamo files where `file_path != canonical_target`) always take the rewrite/move path, never the no-op.

## 5. Sync core: idempotent delete + smart unparseable

- [x] 5.1 In the MARK-DELETED branch (`sync.rs:866`): if the parsed doc already has `deleted_in_db == Some(true)` → increment `unchanged`, run orphan detection, and `continue` (no write); only write on the first transition.
- [x] 5.2 Replace the parse-failure fallback: on `parse_object_doc` error, read bytes, normalize CRLF→LF, retry via `parse_object_doc_str`. On success use the parsed doc; on repeated failure `tracing::warn!` and skip the file (no write, no report entry, no mark-deleted).
- [x] 5.3 Initialize and thread the `unchanged` counter through `execute_sync`; populate it in the final `SyncReport`.

## 6. Sync core tests

- [x] 6.1 Re-sync with no schema change → second run: zero writes, all objects in `unchanged`, empty created/updated/marked_deleted (assert via file mtimes or byte snapshots).
- [x] 6.2 Add one column → exactly one `UpdatedObject` with the right `changes`; all other files byte-identical and counted unchanged.
- [x] 6.3 Add one new table → exactly one `created`, others untouched/unchanged.
- [x] 6.4 Already-`deleted_in_db: true` table re-synced → not rewritten, not in `marked_deleted`.
- [x] 6.5 CRLF file with matching schema → not rewritten (no-op via retry); CRLF file with changed schema → rewritten with LF.
- [x] 6.6 Corrupt (unparseable even after CRLF normalize) file → skipped, left byte-for-byte intact, warning logged.
- [x] 6.7 Verify all four engines exercise the diff path (Postgres/MySQL/MSSQL/Dynamo) via the existing synthetic-shape test harness.

## 7. Frontend

- [x] 7.1 Update `types.ts` `SyncReport` to mirror `UpdatedObject` and `unchanged`.
- [x] 7.2 Update `SyncReportModal.tsx`: render each updated object's path with its `changes` as a sub-list; add a count-only `Unchanged (N)` line; keep the "No changes" empty state (now also true when only `unchanged` > 0 with everything else empty — show "No changes — schema is already up to date.").
- [x] 7.3 Update `api.ts` and `ContextFolderRow.tsx` for the new shape; fix `ContextFolderRow.test.tsx` and any other affected tests.
- [x] 7.4 Verify against `DESIGN.md` (typography, spacing, no AI-slop) for the new diff rows.

## 8. Verification

- [x] 8.1 `cargo test` (context module) and `cargo clippy` clean.
- [x] 8.2 Frontend test suite + typecheck clean.
- [x] 8.3 Manual: link a folder, sync twice, confirm second run reports all-unchanged and produces no git diff / no watcher refresh.
