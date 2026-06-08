## Why

The `dynamo-filter-by-model` change introduced `dynamo_model` docs — the entity layer that powers "By model" filtering in the Dynamo QueryBuilder — but those docs are **authored by hand**: the user must write YAML frontmatter (`access_patterns`, `pk`/`sk` templates) into `dynamo/tables/<table>/models/<Model>.md` with no validation until they try to query. There is no write path in the app at all: the only command that writes context docs is `context_sync_schema`, which produces physical-table docs from introspection. This change gives users a UI to create, edit, and delete model docs, validated against the live table schema before anything touches disk.

This is the first of the two paths in issue #73 (manual editor). It is a prerequisite for the second path (AI inspector, #73 / separate change): the inspector will produce the same model drafts and write them through the exact same validated path delivered here.

## What Changes

- Introduce a **write path** for model docs: two new backend commands `context_save_model` and `context_delete_model`. `context_save_model` serialises a model's `name` + `access_patterns` + optional Markdown body into a `dynamo_model` doc and writes it atomically to `dynamo/tables/<table>/models/<Model>.md`, reusing the existing atomic-write + `human:`/body-preserving splice machinery from `sync.rs`. `physical_table` is **derived from the target table**, never accepted from the caller (D7-bis from the base change).
- Define a single **`ModelDraft`** shape (`{ name, access_patterns[], body? }`) that is the input to the write path — and, in the AI-inspector change, the output of the inspector. The manual form and the AI inspector produce the identical core shape.
- Add a **validation gate** that runs the existing front-end `modelCompiler` against the open table's `TableDescription` before saving: each access pattern's `index` must exist, resolved PK/SK attribute names must exist, key typing (D5/D5-bis) must hold, and templates must parse (D9). Validation is **best-effort**: if the live `TableDescription` is unavailable, grammar-only validation runs and the user is warned that schema checks were skipped.
- Add an **editor UI** reachable from the QueryBuilder "By model" selector (a "＋ New model" / "Edit" affordance): a form to name the entity, add/remove/reorder access patterns (index dropdown sourced from `TableDescription`, `pk`/`sk` template inputs), edit the Markdown body, with a live compiled-key preview and inline validation errors. Saving writes through `context_save_model`; the folder watcher re-fetches and the new/edited model appears in the selector.

## Capabilities

### New Capabilities
- `dynamo-model-editor`: the model-doc editor UI (form, validation gate, compiled-key preview) and the `ModelDraft` contract that feeds the write path. Covers create, edit, and delete from the data-view.

### Modified Capabilities
- `dynamo-context-models`: gains a **write path** — `context_save_model(connection_id, table, draft)` and `context_delete_model(connection_id, table, model_name)` — alongside the existing read/parse requirements. Writes are atomic and preserve any existing `human:` block and body byte-for-byte; `physical_table` is derived from the target table, never authored.

## Impact

- **Backend** (`src-tauri/src/modules/context/`): `commands.rs` (new `context_save_model` / `context_delete_model`), `sync.rs` (reuse `atomic_write` + `rewrite_file` splice for a single doc; extract a model-doc serialiser if needed). `types.rs` unchanged — `AccessPattern` / `ObjectSystem` already model the shape. `parser.rs` unchanged — it already reads what we write.
- **Frontend** (`src/modules/dynamo/data-view/`): new `ModelEditor` component + `ModelDraft` type, an entry point on the "By model" selector in `QueryBuilder.tsx`, a save/delete API wrapper (`api.ts`), reuse of `modelCompiler.ts` for the validation gate, optimistic handling vs the folder watcher in `useTableModels.ts`.
- **Out of scope** (the AI-inspector change): AI repo-inspection to generate drafts, `project_source_path`, the inspector command and prompt. Also out: editing non-Dynamo context docs, a standalone context-folder management view, CloudWatch.
