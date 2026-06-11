## Why

Today a Dynamo schema sync writes each table doc as a **flat file** at `dynamo/tables/<table>.md`, while AI-inspected / hand-authored models for that same table live in a **folder** at `dynamo/tables/<table>/models/<Model>.md`. The result is a split, inconsistent layout: a synced table is a flat sibling file next to a directory of the same name that holds its models. Each logical table should instead be one self-contained folder that holds both the table doc and its models, matching the structure the AI model inspector already produces.

## What Changes

- **BREAKING (on-disk layout):** Dynamo schema sync writes the table doc to `dynamo/tables/<logical>/table.md` instead of the flat `dynamo/tables/<logical>.md`. Each table becomes a folder: `dynamo/tables/<logical>/table.md` (the `dynamo_table` doc) alongside `dynamo/tables/<logical>/models/<Model>.md` (its `dynamo_model` docs).
- The `SyncReport` paths returned for Dynamo change from `dynamo/tables/<table>.md` to `dynamo/tables/<table>/table.md`. Logical-name folding, collision-skip, and in-place update of the `human:` block and body are all preserved against the new path.
- **Migration:** on sync, a pre-existing legacy flat `dynamo/tables/<table>.md` is relocated to `dynamo/tables/<table>/table.md` (bytes moved, so the `human:` block and body survive) before the `system:` splice is applied — so a re-sync upgrades old folders in place without losing hand-written content.
- The context parser reads the table doc from `dynamo/tables/<table>/table.md`. For backward compatibility it continues to recognize a legacy flat `dynamo/tables/<table>.md`; when both exist for the same table the folder doc wins.
- Docs and the example folder (`README.md` "Context folders", `docs/context-folder-example/dynamo/`) are updated to the folder layout.
- **Unchanged:** model write/read paths (`dynamo/tables/<table>/models/<Model>.md`), all other engines (Postgres/MySQL/MSSQL/Athena flat-per-schema, CloudWatch), and the frontmatter format itself.

## Capabilities

### New Capabilities
<!-- none — this modifies existing behavior -->

### Modified Capabilities
- `connection-context-folders`: the Dynamo schema-sync target path changes to `dynamo/tables/<logical>/table.md`, the `SyncReport` paths follow, and a sync migrates any pre-existing legacy flat `dynamo/tables/<logical>.md` into the folder.
- `dynamo-context-models`: the parser reads the physical-table doc from `dynamo/tables/<table>/table.md` (with backward-compatible recognition of the legacy flat `dynamo/tables/<table>.md`), still coexisting with — never shadowed by — the `models/` docs in the same folder.

## Impact

- **Backend** (`src-tauri/src/modules/context/sync.rs`): `target_path_for` for `EngineKind::Dynamo` returns `<root>/dynamo/tables/<name>/table.md`; `execute_sync`'s existing-file walk and legacy-flat-file migration updated to the folder layout.
- **Backend** (`src-tauri/src/modules/context/parser.rs`): the Dynamo branch parses `tables/<table>/table.md` as the `dynamo_table` doc in addition to the legacy flat walk, keeping the `models/` walk intact.
- **Docs**: `README.md` "Context folders" and `docs/context-folder-example/dynamo/` reflect the new per-table folder.
- **Out of scope:** changing model file paths, other engines, the frontmatter schema, or any UI.
