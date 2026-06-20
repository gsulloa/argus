## Why

Today `execute_sync` unconditionally rewrites every existing object file's `system:` block on every run — `shape_to_system` always stamps `last_synced: Utc::now()`, so even byte-identical schemas produce a frontmatter change. Re-syncing a 200-table folder after adding one column shows 200 modifications, fills git history with no-op commits, and fires the filesystem watcher spuriously. Sync should be surgical: touch only what actually changed and tell the user exactly what changed.

## What Changes

- **Diff-aware UPDATE**: before rewriting an existing file, compare the parsed on-disk `system:` block against the live `ObjectShape` (kind, schema, name, primary_key, columns `[{name,type}]` order-sensitive — ignoring `last_synced`, `deleted_in_db`, and per-column extras). If equal → **no-op**: do not rewrite, do not bump `last_synced`, report as `unchanged`.
- **Idempotent delete marking**: a file already carrying `deleted_in_db: true` whose table is still missing from the live schema is a **no-op** (today it is re-stamped every run). Only the first transition to deleted writes.
- **Smart unparseable handling**: if an existing file fails to parse, retry once after normalizing CRLF→LF. If it parses on retry, proceed normally (preserves today's CRLF→LF repair). If it still fails, **log and skip — never overwrite** (protects truly-corrupt files; aligns with "resync is additive, never destructive").
- **Per-object change reporting**: `SyncReport.updated` becomes a list of `{ path, changes: [..] }` where each change is a human string (`"added column foo"`, `"removed column bar"`, `"type of baz: int → bigint"`, `"primary key changed"`, `"column order changed"`). A new `unchanged: <count>` field reports the no-op count (count only, not listed). **BREAKING** to the `SyncReport` IPC contract.
- **Sync dialog as a real diff**: `SyncReportModal` renders the per-object change summaries and an "unchanged (N)" line instead of a flat path list.
- Works for all current introspectors: Postgres, MySQL, MSSQL, Dynamo (and Athena, which shares the same executor).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `connection-context-folders`: schema sync gains diff-awareness — re-running with no schema change produces zero writes; adding one column modifies exactly one file; the `SyncReport` carries per-object change summaries plus an `unchanged` count; unparseable files are repaired-or-skipped, never overwritten.

## Impact

- **Rust** (`src-tauri/src/modules/context/`):
  - `sync.rs` — `execute_sync` UPDATE and MARK-DELETED branches gain no-op guards; new `system_block_unchanged()` predicate and `diff_system()` change-string builder; smart CRLF re-parse on parse failure.
  - `types.rs` — `SyncReport.updated: Vec<PathBuf>` → `Vec<UpdatedObject>`; add `UpdatedObject { path, changes }` and `unchanged: usize`.
  - `parser.rs` — extract a string-based `parse_object_doc_str(raw, source_path)` from `parse_object_doc` so the executor can retry parsing CRLF-normalized content in memory.
- **Frontend** (`src/modules/context/`):
  - `types.ts` — mirror the new `SyncReport` shape (`updated` objects, `unchanged`).
  - `SyncReportModal.tsx` — render per-object change lists and the unchanged count.
  - `api.ts`, `ContextFolderRow.tsx`, existing component tests — updated for the new shape.
- **Tests**: new `execute_sync` cases (idempotent re-sync = zero writes; single-column add = one update with correct change strings; idempotent delete; CRLF re-parse; corrupt-file skip). No new dependencies.
