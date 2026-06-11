## 1. Sync write path (`sync.rs`)

- [x] 1.1 Change the `EngineKind::Dynamo` arm of `target_path_for` to return `root/dynamo/tables/<name>/table.md` (was `root/dynamo/tables/<name>.md`). Update the doc-comment table at the top of the fn.
- [x] 1.2 In `execute_sync`, before writing each Dynamo table doc, detect a pre-existing legacy flat `dynamo/tables/<logical>.md`: if it exists and the new `tables/<logical>/table.md` does not, create the parent dir and relocate (move/rename) the legacy file's bytes to the new path, then proceed with the normal splice. If both already exist, leave the legacy flat file untouched (folder doc wins).
- [x] 1.3 Update `execute_sync`'s existing-file walk so it enumerates Dynamo table docs at `tables/<name>/table.md` (and still recognizes legacy flat `tables/<name>.md`) when computing created/updated/`deleted_in_db`. Ensure a re-sync produces no spurious deletes for already-migrated tables.

## 2. Parser read path (`parser.rs`)

- [x] 2.1 In the `EngineKind::Dynamo` branch, for each `tables/<name>/` directory parse `tables/<name>/table.md` (when present) as the `dynamo_table` doc, alongside the existing `tables/<name>/models/` walk.
- [x] 2.2 Keep the legacy flat walk of `tables/*.md`; when both `tables/<name>.md` and `tables/<name>/table.md` exist for the same logical name, the folder `table.md` wins and the flat file is skipped (no duplicate `dynamo_table` object).

## 3. Tests

- [x] 3.1 `parser.rs`: update existing Dynamo fixtures/tests that use `tables/<name>.md` to the folder layout `tables/<name>/table.md`; keep at least one legacy-flat test asserting read-compat, and add a folder-wins-over-legacy test.
- [x] 3.2 `sync.rs`: add/extend tests asserting the new `created` paths are `dynamo/tables/<logical>/table.md`, that logical-name folding and collision-skip target the new path, that a re-sync updates `table.md` in place preserving `human:`/body, and that a legacy flat `tables/<logical>.md` is migrated into the folder (flat file gone, `models/` untouched).

## 4. Docs

- [x] 4.1 Update `docs/context-folder-example/dynamo/` to the per-table folder layout (move the example table doc into `dynamo/tables/<table>/table.md`).
- [x] 4.2 Update `README.md` "Context folders" section and any layout tables/trees that show `dynamo/tables/<name>.md` to `dynamo/tables/<name>/table.md`.

## 5. Convergence under normalization rule (field-reported fix)

- [x] 5.1 `sync.rs`: in `execute_sync`, derive the canonical target of an existing parsed Dynamo doc from `normalize(doc.system.name, rule)` instead of the raw `system.name`, so pre-rule docs match the folded live shape and are updated in place (with `system.name` rewritten to the logical name) rather than marked deleted alongside a freshly created logical folder.
- [x] 5.2 `sync.rs`: add a Dynamo-only consolidation pass before the existing-file walk: for each `tables/<X>/` directory or legacy flat `tables/<X>.md` where `normalize(X, rule) = L ≠ X`, merge into `tables/<L>/` — move `table.md` if `L` has none (logical wins otherwise), move `models/*.md` into `tables/<L>/models/` skipping name collisions, remove the `X` directory when emptied, and migrate the flat file to `tables/<L>/table.md` when absent.
- [x] 5.3 Tests: (a) pre-rule folder (`table.md` with human edits + `models/`) + rule → single logical folder, human/body preserved, `system.name` rewritten, report shows updated not deleted+created; (b) stranded `models/`-only physical folder + existing logical `table.md` → models merged, physical folder gone; (c) pre-rule legacy flat physical `.md` + rule → migrated to logical `table.md`; (d) no rule → behavior unchanged.

- [x] 5.4 `sync.rs`: guard the consolidation pass with the set of live logical names — only consolidate an entry whose folded name matches a live table of the current sync, so non-idempotent rules (field-reported `-[0-9A-Za-z]+$`) cannot relocate user-curated folders; tests with the literal field names (`CacheStack-CacheTable*`) for both the over-stripping rule and a correct hash-stripping rule.

## 6. Verify

- [x] 6.1 `cargo test` (context module) green; manually run a Dynamo schema sync against a folder containing a legacy flat doc and confirm it migrates into `tables/<table>/table.md` with content preserved and models intact.
- [x] 6.2 Re-verify after the convergence fix: full `cargo test --lib` green (modulo the pre-existing keychain-dependent `modules::ai` failures).
