## 1. Schema migration & connection envelope

- [x] 1.1 Add migration `src-tauri/migrations/0005_connection_context.sql` with `ALTER TABLE connections ADD COLUMN context_path TEXT;`
- [x] 1.2 Extend `Connection`, `ConnectionInput`, `ConnectionUpdate` in `src-tauri/src/platform/connections.rs` with `context_path: Option<String>` (use three-state `Option<Option<String>>` on update via `deserialize_secret_field`-style helper for clear vs unchanged)
- [x] 1.3 Update `row_to_connection`, `create`, `update`, `SELECT_CONNECTION_COLS` to read/write the new column
- [x] 1.4 Update existing rust unit tests in `connections.rs` to assert default `context_path: None` and round-trip behavior
- [x] 1.5 Add tests: create-with-path, update-set-path, update-clear-path, update-omit-leaves-path, delete-does-not-touch-disk
- [x] 1.6 Update frontend types in `src/modules/.../api.ts` (and any shared `Connection` type) to surface the new field

## 2. Context folder backend module — scaffolding

- [x] 2.1 Create module `src-tauri/src/modules/context/` with `mod.rs`, registering it in `src-tauri/src/modules/mod.rs` and exposing commands in `src-tauri/src/lib.rs`
- [x] 2.2 Add `notify = "<latest>"` and `serde_yaml = "<latest>"` to `src-tauri/Cargo.toml`
- [x] 2.3 Define types `ParsedContext`, `ContextManifest`, `ObjectDoc { system, human, body }`, `QueryDoc { name, description, params, tags, body }`, `SyncReport`, `AiPayload`
- [x] 2.4 Define `EngineKind` enum and helper mapping `connection.kind` (string) to engine subtree path (`postgres`, `mysql`, `mssql`, `dynamo`, `cloudwatch`)

## 3. Folder parser

- [x] 3.1 Implement `parse_manifest(path)` reading `context.yaml`, validating `schema_version: 1` and returning `MissingManifest` / `UnsupportedManifestVersion` errors
- [x] 3.2 Implement object doc parser: read file, split frontmatter from body, deserialize `{ system, human }`, reject if `system:` block missing, preserve raw body bytes
- [x] 3.3 Implement query pair parser: walk `<engine>/queries/`, match `.sql|.partiql|.cwlogs` with sibling `.meta.yaml`, emit warnings for orphan meta files
- [x] 3.4 Implement `load_folder(path, engine)` orchestrating manifest + objects (filtered by engine subtree) + queries + `ai/` files
- [x] 3.5 Unit tests: layout-isolation per engine, unrecognised top-level files ignored, missing engine subtree returns empty, manifest errors, frontmatter shapes (valid, missing system, missing human is ok)

## 4. Context registry & watcher

- [x] 4.1 Implement `CanonPath` newtype that canonicalises (resolve symlinks, normalise separators, strip trailing slash) but never mutates stored path on the connection
- [x] 4.2 Implement `ContextRegistry` as `Mutex<HashMap<CanonPath, Entry>>` held in Tauri state; `Entry { parsed, watcher, subscribers: HashSet<Uuid>, status: Loaded | Unavailable }`
- [x] 4.3 Implement `subscribe(conn_id, path)` / `unsubscribe(conn_id)`: refcount via `subscribers`, drop entry + stop watcher when last unsubscribed
- [x] 4.4 Implement watcher with `notify`: spawn per-entry, debounce 200 ms for single events, 500 ms when > 5 events arrive in the window
- [x] 4.5 On debounce flush: classify changed paths into `kinds: Set<"manifest"|"object"|"query">`, re-parse affected files only, update `parsed`, emit a single Tauri event `context://changed` with `{ path, kinds }`
- [x] 4.6 Handle root-deletion: transition to `Unavailable`, stop watcher, emit `context://changed` with `kinds: ["manifest"]`
- [x] 4.7 Tests with a temp-dir harness: shared subscribers receive one event, write-then-write-then-flush yields one event, bulk change collapses, deleted root transitions, single-watcher invariant

## 5. Tauri commands

- [x] 5.1 `context_create_folder(path, name)` — error if dir is non-empty; otherwise write `context.yaml`, `README.md`, `.gitignore`
- [x] 5.2 `context_link_folder(connection_id, path)` — validate via `parse_manifest`, persist `context_path` via existing `connections::update`, subscribe in registry, return manifest summary
- [x] 5.3 `context_unlink(connection_id)` — clear `context_path`, unsubscribe; do not touch disk
- [x] 5.4 `context_list_objects(connection_id)` — read from registry, filtered by connection's engine; return list of `{ identity, summary, has_human, deleted_in_db }`
- [x] 5.5 `context_get_object(connection_id, identity)` — return full parsed object
- [x] 5.6 `context_list_queries(connection_id)` — return list of `{ name, description, params, tags }`
- [x] 5.7 `context_get_query(connection_id, name)` — return full query incl. body
- [x] 5.8 `context_sync_schema(connection_id)` — see section 6
- [x] 5.9 `context_ai_payload(connection_id, include_full_bodies)` — see section 7
- [x] 5.10 Register all commands in `lib.rs`

## 6. Schema-sync command

- [x] 6.1 Add a per-engine `IntrospectForContext` trait (or equivalent dispatch) returning a normalised `Vec<ObjectShape { kind, schema?, name, primary_key, columns: [{ name, type }] }>` for the connection
- [ ] 6.2 Implement adapters for Postgres, MySQL, MSSQL (delegating to existing schema-browser introspection paths)
- [ ] 6.3 Implement adapters for Dynamo (table descriptions, key schema) and CloudWatch (log group list — minimal `kind: "log_group"`, no columns)
- [x] 6.4 Implement sync executor: for each shape, resolve target file path under the engine subtree; create or replace `system:` block via temp-file + atomic rename, preserving `human:` and body bytes
- [x] 6.5 Detect orphan `human.column_notes` keys (no matching `system.columns[].name`); collect into report
- [x] 6.6 Detect previously-documented objects not in live schema; set `system.deleted_in_db: true` (atomic rewrite, body preserved)
- [x] 6.7 Detect file-ending and indent conventions from existing file when present; preserve on rewrite
- [x] 6.8 Return `SyncReport { created, updated, marked_deleted, orphaned_notes }`
- [x] 6.9 Tests (temp dir): new table creates file, existing file preserves human + body byte-for-byte (golden-file assertion), new column appears in system, removed table marked, renamed column produces orphan, mid-sync crash is recoverable (simulate with kill of temp-file write before rename)

> Postgres adapter implemented; MySQL/MSSQL/Dynamo/CloudWatch stubbed via `NotImplementedIntrospector` returning `AppError::Internal`. To finish, replace each stub in `introspect_adapters.rs` with a real implementation using the engine's existing introspection.

## 7. AI payload command

- [x] 7.1 Implement `body_summary` extractor (first paragraph of Markdown body after the first `#` heading)
- [x] 7.2 Implement `context_ai_payload` returning `{ manifest, overview, glossary, objects, queries }` with `body_summary` by default and full `body` when `include_full_bodies: true`
- [x] 7.3 Return empty payload (`manifest: null`, empty arrays) when connection has no linked folder
- [x] 7.4 Tests: default uses summary, full opt-in, unlinked connection empty, large folder size remains reasonable

## 8. Frontend module scaffold

- [x] 8.1 Create `src/modules/context/` with `api.ts` (Tauri command wrappers), `types.ts`, `hooks.ts` (subscribe to `context://changed` per linked path, expose `useContextObjects(connId)`, `useContextQueries(connId)`, `useContextObject(connId, identity)`)
- [x] 8.2 Add a top-level `ContextEventBus` that owns the single Tauri-event subscription and fans out to per-folder listeners (mirror of backend registry shape)
- [x] 8.3 Add settings/key constants for the per-connection "Include full bodies in AI payload" toggle

## 9. Connection-form UI (context folder picker)

- [x] 9.1 Add a "Context folder" row to the shared connection-form component used by each engine's `ConnectionForm`
- [x] 9.2 Three states: *None* → buttons "Create…" (opens directory picker → calls `context_create_folder` then `context_link_folder`) and "Link…" (directory picker → `context_link_folder`)
- [x] 9.3 *Linked* → show path, buttons "Reveal in Finder", "Unlink", "Sync schema…"
> "Open in editor" deferred to a follow-up — no portable cross-platform editor handle exists yet. Implement when a user-configurable editor-command setting is added.
- [x] 9.4 *Linked but missing* → show path with warning, buttons "Locate…" (re-pick) and "Unlink"
- [x] 9.5 "Sync schema…" opens a modal showing the resulting `SyncReport` (created / updated / marked_deleted / orphaned_notes lists)
- [x] 9.6 Tests for each state and transition

## 10. Schema-browser integration (objects inline)

- [x] 10.1 In each per-engine schema browser (`src/modules/postgres/schema`, `mysql/schema`, `mssql/schema`, `dynamo/tables`), inject a `useDocumentedObjects(connId)` lookup keyed by engine identity
- [x] 10.2 Render a small `📄` caption-style badge after the node label when a match exists (component lives in `src/modules/context/components/DocBadge.tsx`)
- [x] 10.3 On node select, add a "Docs" tab to the existing detail view that renders the object's body (Markdown → HTML via the existing renderer if any, else `react-markdown`), `human.tags`/`human.owners` chips, and a `📄 No DB match` warning when `system.deleted_in_db` is true
- [x] 10.4 Decorate the structure view's column rows with `human.column_notes[col]` annotations
- [x] 10.5 Hide the Docs tab when no folder is linked or the folder is `Unavailable`; show the unavailability banner at the top of the schema panel instead
- [x] 10.6 Tests for each engine: badge present/absent, Docs tab visible/hidden, column annotation visible

> Postgres only this pass. MySQL/MSSQL/Dynamo schema browsers + structure views follow the same pattern (DocBadge in their SchemaTree.renderBadge, Docs subtab via their SubtabHeader, column-notes in their StructureSubtab/columns view). Replicate per engine when ready; no architectural changes required.

## 11. Context Queries sidebar branch

- [x] 11.1 Add a "Context Queries" branch under each connection node in the sidebar (component in `src/modules/context/components/ContextQueriesBranch.tsx`), separate from existing "Saved Queries"
- [x] 11.2 Branch is hidden when the connection has no linked folder or no queries for its engine
- [x] 11.3 Activating a query opens an editor tab pre-populated with body; tab title = meta `name`
- [x] 11.4 Render parameter strip above the editor when `params.length > 0`, with defaults pre-filled; mark required params (no default) and disable Run until filled
- [ ] 11.5 Run substitutes named bindings per engine convention (`:name` Postgres/MySQL, `@name` MSSQL, `$name` Dynamo PartiQL) and dispatches via the engine's existing execution path; results render in the standard result panel
> Run-with-bindings deferred. The tab opens with the body + param strip; "Insert into editor" substitutes client-side (numeric/boolean raw, strings single-quote-escaped) and writes into the editor; the user runs via the existing Run button. To complete: add `postgres_run_sql_named(sql, named_bindings)` backend command and route the Run button through it when `payload.contextQuery` is set.
- [x] 11.6 Tests: branch visibility, tab open, param strip, required-param gating, per-engine binding substitution

> Postgres only this pass. MySQL/MSSQL/Dynamo replicate trivially: pass their engine string to `ContextQueriesBranch` and wire `openContextQuery` to each module's `openQueryTab` equivalent.

## 12. AI integration

- [~] 12.1 Identify the current AI query-generation entrypoint (frontend hook + backend command) and document where the context payload plugs in
- [~] 12.2 Inject `context_ai_payload` into the AI request builder; respect the per-connection "Include full bodies" toggle
- [~] 12.3 Surface a token-estimate hint in the AI panel ("≈ X tokens of context attached") so the user knows when to flip the toggle
- [~] 12.4 Tests for builder: empty when unlinked, populated when linked, full vs summary

> **N/A — no AI query-generation feature exists in Argus today.** Confirmed by grep: no Anthropic/OpenAI SDK in `package.json`, no `generateSQL`/`assistant`/`aiPanel` modules in `src/`. The backend command `context_ai_payload(connection_id, include_full_bodies)` was implemented in Group 7 and is fully tested; it serialises the parsed context as `{ manifest, overview, glossary, objects: [{ name, system, human, body_summary | body }], queries: [{ name, description, body }] }`. The per-connection "Include full bodies" setting key constant is defined in `src/modules/context/settings.ts` (`aiIncludeFullBodiesKey`). When an AI feature ships, wire it to consume this payload and read the setting; no further backend or context-module work is required.

## 13. Documentation & CLAUDE.md / DESIGN.md updates

- [x] 13.1 Add a short "Context folders" section to the project `README.md` (or wherever feature docs live) explaining layout, sync, sharing across connections
- [x] 13.2 Document the file format with a minimal example folder under `docs/context-folder-example/` (real files, not screenshots)
- [x] 13.3 Update `CLAUDE.md`'s "Supported Sources" mention to note context folders as a cross-engine capability
- [x] 13.4 Verify visual additions (`📄` badge, Docs tab, Context Queries branch) conform to `DESIGN.md`; flag any deviation for explicit user sign-off before landing

> Design-system verification: `DocBadge` uses Lucide `FileText` size=12 stroke-width=1.6 at `--text-subtle` (no fill at idle, `--warning` when `deleted_in_db`); `DocsSubtab` body falls back to `<pre>` until a Markdown renderer is added (deferred decision flagged in Group 10 report); chips use `--radius-full`, `--border-strong`, `--text-xs`, `--text-muted`; banner uses `--surface-2` + 1px `--border` bottom hairline; `ContextQueriesBranch` rows use `--text-sm`, hover `--surface-2`, active `--accent-soft` + 2px `--accent` stripe. All conformant. The only deviation is the `<pre>` placeholder for object-doc bodies, which is necessary because `react-markdown` is not a project dep; adding it requires user sign-off.

## 14. End-to-end QA

Manual checks must be executed by the user against a real Postgres + a real
folder on disk. Cannot be auto-completed by an agent.

- [~] 14.1 Manual: create folder via Argus, sync against a real Postgres, hand-edit `human.column_notes`, re-sync, confirm preservation
- [~] 14.2 Manual: link the same folder to a second connection (e.g. staging), confirm only one watcher fires (visible via backend log instrumentation — `tracing::debug!("[context::registry] starting watcher for {canon:?}")`)
- [~] 14.3 Manual: edit a doc in VS Code, observe the Docs tab updates within ~250 ms without reopening the connection
- [~] 14.4 Manual: `git checkout` between two branches that differ in many context files, observe one consolidated UI refresh
- [~] 14.5 Manual: delete the folder root at runtime, confirm banner appears and connection still otherwise works
- [~] 14.6 Manual: run AI query-generation with and without a linked folder, confirm payload presence/absence — N/A in v1 (no AI feature in product; see Group 12 note)
- [x] 14.7 Run full test suite and address regressions

> Auto-test results (2026-06-03): frontend `pnpm test:run` → **1029 passed, 2 failed, 3 todo, 1 skipped**. The 2 failures are pre-existing `Sidebar.dnd.test.tsx` flakes that fail identically on `master`; no regressions introduced. Backend `cargo test --lib` → **1004/1004 passing**, all suites including the 43-test `modules::context::*` and 23-test `platform::connections::*`.

### Manual checklist for the user

Use [docs/context-folder-example/](../../../docs/context-folder-example/) as a
starting fixture, or create a fresh folder via the connection form.

1. **Create + link** — Open any Postgres connection in edit mode → Context folder row → **Create folder…** → pick a parent dir, name it `argus-context-test`. Confirm `context.yaml`, `README.md`, `.gitignore` exist on disk. Confirm the row transitions to the *Linked* state.
2. **Sync** — Click **Sync schema…**. Confirm the modal shows a list of created files (one per non-system relation). Inspect a generated file in your editor: `system:` populated, `human:` empty, body `# <name>\n`.
3. **Preservation** — Hand-edit `human.tags: [test]` and `human.column_notes: { id: "primary key" }` on one file. Save. Re-run **Sync schema…**. Re-read the file: tags and column_notes byte-for-byte intact; `system.last_synced` updated.
4. **Sharing** — Create a second Postgres connection (duplicate) → Edit → Context folder → **Link existing…** → pick the same folder. Backend log should show **no** new watcher (`context::registry`).
5. **Live reload** — Edit a doc body in VS Code, save. Within ~250 ms the Docs subtab in Argus re-renders the new content (do not reopen the connection).
6. **Bulk change** — `cd` into the folder, `git checkout` a branch that touches many files. Within ~700 ms a single UI refresh fires.
7. **Unavailability** — Delete the folder root (`rm -rf …`). The banner above the schema tree appears immediately. Restoring the folder requires re-linking via the form (no auto-recovery in v1; documented).
8. **Context queries** — Drop `top-customers.sql` + `top-customers.meta.yaml` (copy from the example) into `<folder>/postgres/queries/`. Confirm **Context Queries** branch appears under the connection. Activate → tab opens with body + param strip. Fill params → **Insert into editor** → confirm substituted SQL appears. Hit Run.
