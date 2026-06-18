## 1. Backend: write path for model docs

- [x] 1.1 Add `context_save_model(connection_id, table, draft)` in `src-tauri/src/modules/context/commands.rs`. Resolve the linked context folder (error if none linked), build the `system:` block from the draft (`kind: dynamo_model`, `name`, `access_patterns`; **never** write `physical_table`), and write to `<root>/dynamo/tables/<table>/models/<slug(name)>.md`
- [x] 1.2 Reuse the atomic-write + splice machinery from `sync.rs` (`atomic_write`, `rewrite_file`): on an existing file, replace only the `system:` block and preserve the `human:` block + body byte-for-byte; on a new file, write `system:` + the draft `body` (or empty). Extract the smallest shared helper that keeps one splice implementation (decision D2)
- [x] 1.3 Add `context_delete_model(connection_id, table, model_name)` that removes `<root>/dynamo/tables/<table>/models/<slug(name)>.md`; no-op-safe if already gone (return a clear result, not an error)
- [x] 1.4 Slug + collision rule: derive the filename from `name` (`[A-Za-z0-9_-]`, collapse/strip others, non-empty); reject a save whose slug collides with a different existing entity in the table's `models/` dir, with a message naming the conflict (decision D5)
- [x] 1.5 Backend unit tests: new model writes a well-formed doc readable back by the parser with `physical_table` derived from path; editing an existing model preserves its `human:` block + body byte-for-byte; delete removes the file and is no-op-safe; slug collision is rejected; save on a connection with no linked folder errors clearly

## 2. Frontend: ModelDraft contract & API

- [x] 2.1 Add the `ModelDraft` type (`{ name, access_patterns: AccessPattern[], body? }`) to `src/modules/dynamo/data-view/types.ts` (reuse the existing `AccessPattern` type)
- [x] 2.2 Add API wrappers `saveModel(connectionId, table, draft)` and `deleteModel(connectionId, table, name)` in `api.ts` over the new commands

## 3. Frontend: validation gate

- [x] 3.1 Add a `validateDraft(draft, describe)` path that runs `modelCompiler.compileModel` per access pattern: full validation when `TableDescription` is present (index exists, PK/SK attrs exist, typing D5/D5-bis, grammar D9); grammar-only when absent (decision D3)
- [x] 3.2 Map compiler errors to per-access-pattern inline messages; produce an overall valid/invalid + a "schema checks skipped (table not reachable)" warning state
- [x] 3.3 Unit tests: unknown index rejected; numeric (`N`) key with prefix rejected; malformed `${` rejected; valid draft passes; offline (no describe) → grammar-only pass with the skipped-checks warning

## 4. Frontend: editor UI

- [x] 4.1 Build a `ModelEditor` component (panel/dialog over the data-view): entity name input, an access-pattern list with add/remove/reorder, each row an index dropdown (sourced from `TableDescription` indexes) + `pk`/`sk` template inputs, and a Markdown body field
- [x] 4.2 Live compiled-key preview per access pattern (reuse the QueryBuilder preview) + inline validation from §3; disable Save while invalid
- [x] 4.3 Add the "＋ New model" / "Edit" entry point on the "By model" entity selector in `QueryBuilder.tsx` (decision D4); seed the form from the selected model when editing (name, access patterns, existing body)
- [x] 4.4 Save calls `saveModel`; delete calls `deleteModel` behind a confirm. Apply an optimistic update and reconcile against the folder-watcher refetch in `useTableModels.ts` so the saved model does not flash out and back (decision D6)
- [x] 4.5 When the connection has no linked context folder, prompt to link/create one (reuse the existing link flow) instead of failing silently
- [x] 4.6 Component test: create a model → it appears in the selector and is queryable; edit it (change an access pattern) → query reflects the change and a hand-written body is preserved; delete → it disappears; round-trip an edit with no body change → on-disk body unchanged

## 5. Docs & verification

- [x] 5.1 Update `README.md` "Context folders" to note model docs can be created/edited in-app (not only by hand); update `docs/context-folder-example/` if a generated sample helps
- [ ] 5.2 Manual verification against a real STD table: create two entities via the form, fill access patterns (full + partial), confirm the compiled-key preview, save, and query by each; edit one and confirm the body survives; delete one
- [ ] 5.3 Confirm a connection with no linked folder is guided to link one, and that offline editing surfaces the skipped-schema-check warning
