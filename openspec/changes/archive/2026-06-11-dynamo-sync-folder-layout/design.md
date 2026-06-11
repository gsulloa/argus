## Context

The context-folder layout for Dynamo grew in two passes that disagree:

- **Schema sync** (`sync.rs::target_path_for`, `parser.rs`) writes the physical-table doc as a flat file: `dynamo/tables/<logical>.md`.
- **AI model inspector / model editor** (`commands.rs::context_save_model`) writes entity docs into a folder: `dynamo/tables/<logical>/models/<Model>.md`, and the parser derives `physical_table` from the `<logical>` directory name (`parser.rs:404-427`).

So after a sync-then-inspect, a single logical table is represented by a flat file `tables/Events.md` *plus* a directory `tables/Events/models/…` sitting next to it. The two halves of one table live in unrelated filesystem nodes. The fix: sync writes the table doc *inside* the table's folder (`tables/<logical>/table.md`), so each logical table is one self-contained directory holding `table.md` + `models/`.

Key existing machinery this builds on:
- `target_path_for(root, engine, shape)` (`sync.rs:49-66`) — the single source of truth for where an `ObjectShape` lands.
- `execute_sync` (`sync.rs:544-715`) — walks existing files in the engine subtree to compute created/updated/deleted, then writes atomically via `rewrite_file_with_system_yaml` (splice) / `build_fresh_doc` + `atomic_write`, all of which preserve the `human:` block and body byte-for-byte.
- The Dynamo branch of the parser (`parser.rs:384-495`) already walks `tables/` distinguishing flat `*.md` files (table docs) from `<table>/` directories (model containers).

## Goals / Non-Goals

**Goals:**
- Sync writes the Dynamo table doc to `dynamo/tables/<logical>/table.md`.
- `SyncReport` paths reflect the new location.
- Logical-name folding, collision-skip, in-place update, and `human:`/body byte-preservation all keep working against the new path.
- A sync migrates a pre-existing legacy flat `dynamo/tables/<logical>.md` into the folder without losing hand-written content.
- The parser reads `table.md` from the folder and still reads legacy flat docs (read-time backward compatibility).
- Docs and the example folder reflect the new layout.

**Non-Goals:**
- No change to model file paths, the frontmatter schema, or any UI.
- No change to other engines (Postgres/MySQL/MSSQL/Athena/CloudWatch).
- No standalone migration command — migration happens lazily on the next sync. (Read-time compat covers folders that are never re-synced.)

## Decisions

### D1: Reserved filename `table.md` for the physical-table doc

The table doc lives at `dynamo/tables/<logical>/table.md`. Models already live under `dynamo/tables/<logical>/models/`, so `table.md` sits beside the `models/` subdirectory and cannot collide with any model file (models are one directory deeper). `table.md` is unambiguous and engine-internal.

*Alternatives considered:* `_table.md` (leading underscore to signal "reserved") — rejected as noise, the `models/` sibling already disambiguates. Reusing the logical name (`<logical>/<logical>.md`) — rejected: redundant, and a model named the same as the table would be visually confusing even though it lives a directory deeper.

### D2: `target_path_for` is the only write-path change

Changing the Dynamo arm of `target_path_for` (`sync.rs:57-60`) to `root/dynamo/tables/<name>/table.md` redirects every create and update, because `execute_sync` routes all writes through it. No other write site computes the table-doc path.

### D3: Migration is a move, performed in `execute_sync` before the splice

When `execute_sync` is about to write a table whose new target is `tables/<logical>/table.md`, it first checks for a legacy flat `tables/<logical>.md`. If present and the new `table.md` does not yet exist, it relocates the legacy file's bytes to the new path (create parent dir, move/rename, leaving the `human:` block and body intact), then proceeds with the normal `system:` splice against the new path. This makes a re-sync upgrade old folders transparently. Any pre-existing `tables/<logical>/models/` directory is untouched (it is a sibling, never the table doc).

*Why move-then-splice rather than read-old-write-new:* the splice path (`rewrite_file_with_system_yaml`) already preserves `human:`/body bytes; moving the file first lets that existing, tested code run unchanged against the new location.

*Edge:* if both a legacy flat `tables/<logical>.md` and a `tables/<logical>/table.md` already exist, the folder doc wins — the legacy flat file is left as-is (not deleted) to avoid destroying content the parser already ignores; cleanup can be a later concern. This matches the parser's precedence rule (D4).

### D4: Parser reads `table.md`, with legacy flat read-compat and folder-wins precedence

The Dynamo branch of the parser (`parser.rs:384-495`) is extended so that, for each `tables/<name>/` directory, it parses `tables/<name>/table.md` (if present) as the `dynamo_table` doc in addition to walking `tables/<name>/models/`. The existing flat walk of `tables/*.md` is retained for backward compatibility. When both `tables/<name>.md` (flat) and `tables/<name>/table.md` exist for the same logical name, the folder doc wins and the flat one is skipped — so a folder mid-migration (or never re-synced) never yields a duplicate `dynamo_table` object for the same table.

### D5: `execute_sync` existing-file walk must enumerate `table.md` files

`execute_sync` walks the engine subtree to diff against live shapes (for created/updated/deleted classification). That walk must now find table docs at `tables/<name>/table.md` (folder layout) as well as legacy `tables/<name>.md`, so the deleted-marking and update logic operate on the right set. This mirrors the parser change and uses the same path derivation.

### D6: Sync is convergent under the normalization rule (post-implementation fix)

Field testing surfaced a split layout: configuring a normalization rule *after* content already existed under the physical (suffixed) name made sync create a parallel logical folder, stranding the physical folder's `models/` (which `context_list_models` — rule-aware — can no longer see). Two coordinated fixes:

1. **Rule-aware identity matching.** In `execute_sync`, the canonical target for an existing parsed doc is derived from `normalize(doc.system.name, rule)` for Dynamo (was: the raw `system.name`). Docs whose frontmatter still carries the physical name therefore match the folded live shape and are updated in place — `shape_to_system` rewrites `system.name` to the logical name on that update — instead of being marked deleted while a fresh logical folder is created.
2. **Folder consolidation pass.** Before the existing-file walk, a Dynamo-only pass scans `tables/` for entries whose name normalizes to a *different* logical name: a directory `tables/<physical>/` is merged into `tables/<logical>/` (move `table.md` if the logical folder has none — logical wins otherwise; move `models/*.md` into `tables/<logical>/models/`, skipping name collisions; remove the physical dir when emptied), and a legacy flat `tables/<physical>.md` migrates to `tables/<logical>/table.md` when that target is absent.

*Why both:* consolidation alone leaves the moved `table.md` carrying the physical `system.name`, which without rule-aware matching would immediately be misclassified as deleted on the same sync. Rule-aware matching alone leaves the stranded `models/` invisible. Together a sync converges any pre-rule layout to the logical folder in one pass.

*Collision policy:* mirrors D3 — the logical (canonical) file wins; conflicting physical-side files are left in place rather than overwritten or deleted, treated as benign. No rule configured → `normalize` is identity → both fixes are no-ops.

*Live-logical guard:* `normalize` is not necessarily idempotent — a field-reported rule (`suffix_pattern: "-[0-9A-Za-z]+$"`) folds a hand-curated folder `CacheStack-CacheTable` to `CacheStack`. The consolidation pass therefore only acts on an entry whose folded name is in the set of live logical names of the current sync (the folded `shape.name`s); entries folding to anything else are left untouched.

## Risks / Trade-offs

- **Stale duplicate after partial migration** → If a legacy flat doc and a new folder doc coexist, the parser's folder-wins rule (D4) prevents a duplicate object; the orphan flat file is harmless but lingers. Mitigation: migration (D3) removes the flat file in the common single-doc case; document the rare coexistence as benign.
- **Existing user folders break if read-compat is dropped** → Read-time recognition of the legacy flat path (D4) is mandatory, not optional, precisely so untouched folders keep working before any re-sync.
- **`deleted_in_db` marking against the new layout** → If the walk in `execute_sync` (D5) is not updated in lockstep with `target_path_for`, a synced table could be wrongly classified. Mitigation: derive both the write path and the walk's expected paths from the same helper; cover with a re-sync test that asserts no spurious deletes.
- **Tests and fixtures reference the flat path** → `parser.rs` tests (e.g. lines 780-975) and `docs/context-folder-example/` use `tables/<name>.md`. They must be updated; the legacy-compat scenarios deliberately keep at least one flat-path test alive.

## Migration Plan

1. Ship the parser read-compat (D4) and the sync write-path + migration (D2, D3, D5) together so any re-sync upgrades folders and the read path tolerates both shapes.
2. No data migration step for users: the next `context_sync_schema` per Dynamo connection relocates legacy flat docs automatically; folders never re-synced keep working via read-compat.
3. Rollback: reverting the code leaves migrated `tables/<name>/table.md` files unread by the old parser. This is the one rough edge — note it in the change; in practice a forward-fix is preferred over rollback once a sync has run.

## Open Questions

- Should a future change delete the lingering legacy flat file when a folder `table.md` already exists (D3 edge), or add a one-shot cleanup? Out of scope here; flagged as benign for now.
