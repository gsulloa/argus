## Context

`execute_sync` (`src-tauri/src/modules/context/sync.rs:564`) is the engine-agnostic core that reconciles a `Vec<ObjectShape>` (live schema) against the object docs already on disk. It walks every existing file, parses it, maps it to a live shape, and — in the current code — **always** rewrites the matched file via `rewrite_file(shape_to_system(shape))`. Because `shape_to_system` (`sync.rs:179`) hard-codes `last_synced: Some(Utc::now())`, every file changes on every run even when the schema is byte-identical. The MARK-DELETED branch (`sync.rs:866`) is likewise unconditional.

The comparison surface is small. Live `ObjectShape` (`introspect.rs:17`) has `kind: String`, `schema: Option<String>`, `name: String`, `primary_key: Vec<String>`, `columns: Vec<ObjectShapeColumn{name, ty}>`. On-disk `ObjectSystem` (`types.rs:46`) has the same fields plus `last_synced`, `deleted_in_db`, `access_patterns`, `physical_table`, and `extras`, with `primary_key: Option<Vec<String>>` and `columns: Option<Vec<ObjectColumn>>` (each column carrying an `extras` map).

The result type `SyncReport` (`types.rs:178`) is serialized over IPC and consumed by `SyncReportModal.tsx`, which renders `created` / `updated` / `marked_deleted` as flat path lists. `updated` is currently `Vec<PathBuf>`.

This is a self-contained behavioral change to one module plus its IPC contract and the one modal that reads it. No new dependencies. The Dynamo D3/D6 migration machinery (consolidation, legacy-flat relocation) is orthogonal and must keep working.

## Goals / Non-Goals

**Goals:**
- Re-syncing an unchanged schema produces zero file writes (all engines).
- Adding/removing/retyping one object touches exactly that object's file.
- Idempotent delete-marking: a table already marked `deleted_in_db: true` is a no-op.
- The `SyncReport` carries a per-object change summary plus an `unchanged` count; the modal renders it as a diff.
- Unparseable files are repaired-on-retry (CRLF) or skipped — never overwritten.

**Non-Goals:**
- Rename detection (table foo → bar). Still treated as delete + create; a PK-identity rename detector is a follow-up.
- Reordering existing files or changing on-disk layout.
- Changing the Dynamo normalization / consolidation behavior.
- Suppressing orphan-note detection (it stays; see Decisions).

## Decisions

### D1 — Equality predicate excludes timestamps and extras
Add `fn system_block_unchanged(existing: &ObjectSystem, shape: &ObjectShape) -> bool` comparing exactly: `kind`, `schema`, `name`, `primary_key` (normalizing `Vec::is_empty()` ↔ `None`), and `columns` as an ordered list of `(name, ty)` (ignoring each column's `extras`). `last_synced`, `deleted_in_db`, `access_patterns`, `physical_table`, and `extras` are excluded. Rationale: those are machine-stamped or human-owned; including them would defeat the no-op. Order-sensitive per the issue (column order matters for some workflows).

Alternative considered: derive `shape_to_system(shape)` and compare the two `ObjectSystem` values with a custom `PartialEq` that masks volatile fields. Rejected — `shape_to_system` allocates a fresh `now()` timestamp and a full `Vec<ObjectColumn>`; a direct field comparison against the shape is cheaper and the masking rules live in one obvious place.

### D2 — No-op guards slot into the two existing write branches
In the UPDATE branch (`sync.rs:824`): after resolving `shape`, if `doc_opt` is `Some(doc)` and the file is already at its canonical target (`file_path == canonical_target`) and `system_block_unchanged(&doc.system, shape)` and `doc.system.deleted_in_db != Some(true)` → record `unchanged += 1`, run orphan detection (read-only), and `continue` without writing. Otherwise rewrite as today and compute the change list (D4).

The `file_path == canonical_target` guard matters: a file that must be **relocated** (D3/D6 migration — legacy flat or physical-named Dynamo path) is never a no-op even if its columns match, because the bytes must move. Treat relocation as an update.

In the MARK-DELETED branch (`sync.rs:866`): if `doc.system.deleted_in_db == Some(true)` already → `unchanged += 1`, `continue` (still run orphan detection). Only write on the first transition.

### D3 — Smart unparseable handling via a string-based parser entrypoint
Extract `pub fn parse_object_doc_str(raw: &str, source_path: &Path) -> Result<ObjectDoc, ParserError>` from `parse_object_doc` (`parser.rs:97`); the path-based fn becomes `read_to_string` + delegate. In `execute_sync`, when `parse_object_doc(file_path)` fails, read the raw bytes, `replace("\r\n", "\n")`, and retry via `parse_object_doc_str`. If that succeeds, use the parsed doc (this is the CRLF-repair path — the subsequent rewrite emits LF). If it still fails, `tracing::warn!` and skip the file entirely (do not add to any report list, do not mark deleted, do not overwrite).

This replaces today's path-based-identity fallback (`sync.rs:780-820`, `doc_opt = None`) for matched-and-present files. Rationale: diff-awareness needs a parsed block to compare; "can't parse → can't safely touch" is the issue's explicit "never recreate" rule. Consequence: genuinely corrupt files stop being silently overwritten — the intended behavior.

Alternative considered: keep the path-based fallback and rewrite unparseable-but-live files (pure-diff on the happy path only). Rejected by product decision — protecting corrupt files wins, and the CRLF retry recovers the only common parse failure.

### D4 — Change-string builder
Add `fn diff_system(old: &ObjectSystem, shape: &ObjectShape) -> Vec<String>` producing human strings:
- Added column → `"added column {name}"` (in shape, not in old, by name).
- Removed column → `"removed column {name}"` (in old, not in shape).
- Type change → `"type of {name}: {old_ty} → {new_ty}"` (same name, different `ty`).
- PK change → `"primary key changed"` (normalized empty↔None compare differs).
- Column order change → `"column order changed"` (same set of `(name,ty)` but different order; only when no add/remove/type change already explains it).

This runs only on the rewrite path, so it never costs anything on no-ops.

### D5 — `SyncReport` shape change (BREAKING IPC)
In `types.rs`: add `struct UpdatedObject { path: PathBuf, changes: Vec<String> }`; change `SyncReport.updated: Vec<PathBuf>` → `Vec<UpdatedObject>`; add `unchanged: usize` (`#[serde(default)]` for forward-compat with any persisted reports, though reports are not persisted). Frontend `types.ts` mirrors it; `SyncReportModal.tsx` renders each updated object's path with its `changes` as a sub-list and shows `Unchanged (N)` as a count-only line; `api.ts` / `ContextFolderRow.tsx` / component tests follow the new shape.

### D6 — Orphan-note detection stays on, including for unchanged files
Orphan detection (human `column_notes` pointing at dropped columns) is read-only and the doc is already parsed for the comparison, so re-scanning costs nothing and keeps the orphan list complete every run. Run it on the no-op path too. Rationale: suppressing it would hide a real, actionable problem just because the schema didn't change this run.

## Risks / Trade-offs

- **`last_synced` changes meaning** (was "when sync last ran", now "when this object last changed") → Acceptable and arguably better; verify no UI surface presents it as a freshness heartbeat. Grep confirms it is not read by the frontend today.
- **BREAKING `SyncReport.updated` shape** → All consumers are in-repo (one modal, one row component, their tests); update them in the same change. No external API.
- **Corrupt files now skipped instead of overwritten** → A user who *wanted* a corrupt file regenerated must delete it first. This is the explicit product decision; the warning log makes it discoverable.
- **Column-order-only change semantics** → Order-sensitive equality means a pure reorder is reported as a change. Mitigation: distinct `"column order changed"` string so the diff is honest rather than mislabeled as add/remove.
- **D3/D6 relocation interaction** → The `file_path == canonical_target` guard prevents treating a to-be-moved file as a no-op; covered by a test that re-syncs a folder needing migration and asserts the move still happens.

## Migration Plan

Pure code change; no data migration. Existing folders converge naturally: the first post-change sync rewrites only objects whose schema differs from disk (typically none if previously in sync, or many one last time if `last_synced` noise had been masking content equality — but content matches, so those are no-ops). Rollback is reverting the change; on-disk files remain valid under the old code (the new code never writes an incompatible format).

## Open Questions

None blocking. (Rename detection and orphan-note suppression are explicitly deferred.)
