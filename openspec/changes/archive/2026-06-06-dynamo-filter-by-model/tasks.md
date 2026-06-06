## 1. Backend: dynamo_model doc format & parsing

- [x] 1.1 Add typed fields to `ObjectSystem` in `src-tauri/src/modules/context/types.rs`: `access_patterns: Option<Vec<AccessPattern>>` and `physical_table: Option<String>`, with `AccessPattern { name: Option<String>, index: String, pk: String, sk: Option<String> }`. Both `None` for non-Dynamo docs (decision: typed, not `extras`)
- [x] 1.2 Add minimal backend template well-formedness validation: warn (via `LoadWarning`) only on an unterminated `${`; store templates verbatim otherwise. The TS `modelCompiler` is the authoritative parser (no full Rust parser)
- [x] 1.3 Extend `parser.rs` `load_folder` for Dynamo to walk `dynamo/tables/<table>/models/*.md`, parse each via `parse_object_doc`, tag `kind: "dynamo_model"`, and **populate `physical_table` from the parent directory name** (not read from frontmatter); emit `LoadWarning` for empty `access_patterns` or malformed templates
- [x] 1.4 Ensure a `tables/<table>.md` file and a `tables/<table>/` directory coexist — the model docs must not shadow or overwrite the table doc
- [x] 1.5 Add a dedicated `context_list_models(table)` command in `commands.rs` returning models whose derived `physical_table` matches `table`, each with `name` + `access_patterns` (do not extend `context_list_objects`)
- [x] 1.6 Backend unit tests: parses a well-formed model doc with `physical_table` derived from path; preserves multiple same-index access patterns; warns on unterminated `${`; `tables/<t>.md` + `tables/<t>/models/` coexist with no shadowing; table without `models/` dir is unaffected; `context_list_models` returns only matching entities (including the cross-table same-name `Order` case) and `[]` when none

## 2. Frontend: types & model loading

- [x] 2.1 Add model + access-pattern types to `src/modules/dynamo/data-view/types.ts` (`DynamoModel`, `AccessPattern`), a `builderMode: "model" | "raw"` field, and a `modelSelection { entity, accessPattern, params: Record<string,string> }` field on `BuilderState` (model-mode source of truth, persisted)
- [x] 2.2 Add a hook/loader in the data-view that fetches the open table's models via `context_list_models` (reuse the `useContextObject` pattern), exposing `models` and an `isStd` flag (presence-based)
- [x] 2.3 Wire `DataViewTab.tsx` to load models for the open table and pass them (plus `isStd`) to `QueryBuilder`; persist `builderMode` + `modelSelection`. When `isStd` flips false for an open tab, fall back to raw mode preserving the last compiled `query` and hide the toggle

## 3. Frontend: modelCompiler

- [x] 3.1 Implement `${...}` template parser in new `src/modules/dynamo/data-view/modelCompiler.ts` (split into literal/param segments)
- [x] 3.2 Implement the partial-substitution rule: all-filled → equality; trailing-empty (with literal prefix) → `begins_with` on prefix; trailing-empty bare `${param}` (no prefix) or no `sk` → drop SK (partition-only Query); interior gap → error naming the param; unresolved PK → error
- [x] 3.3 Resolve PK/SK attribute names from the selected index's key schema in `TableDescription`, and set each emitted value's type (`S`/`N`) from `attribute_definitions`; produce a `BuilderState.query` (partitionKey `{name,value}`, sortKey `{name,op,value}`, `indexName`) consumed unchanged by `builderCompiler.ts`
- [x] 3.4 Validate that the access pattern's `index` exists in `TableDescription` and that the resolved PK/SK attribute names exist; reject `begins_with` degrade on a non-`S` sort key; return a clear error naming the unknown index/attribute or the non-string key
- [x] 3.5 Unit tests: fully-filled → equality; trailing-empty SK with prefix → `begins_with`; bare empty `${param}` and pk-only → partition-only Query (SK dropped); interior gap rejected with param name; empty PK rejected; **PK trailing-empty rejected (no `begins_with` on PK)**; **numeric (`N`) sort key emits `{type:"N"}` and passes key-type validation**; **partial fill on a non-`S` key rejected**; **unknown index rejected**; output drives `builderCompiler.compile()` to a request identical to equivalent raw-mode input
- [x] 3.6 Embed an ASCII diagram in `modelCompiler.ts` documenting the template→key-condition pipeline (segment split, fill rule, equality/begins_with/drop branches, type inference) per the project's diagram-in-comments convention

## 4. Frontend: QueryBuilder UI

- [x] 4.1 Add the "By model" / "Raw (PK/SK)" toggle to `QueryBuilder.tsx`; hide it (force `raw`) when `isStd` is false so non-STD tables are unchanged
- [x] 4.2 In "By model" mode render: Entity selector (models), Access pattern selector (label = `name` or derived from index+templates; ensure two patterns on the same index produce distinct, disambiguated labels), and one input per distinct derived `${param}`
- [x] 4.3 Compile on change via `modelCompiler` from `modelSelection` (the source of truth), show the compiled key-condition preview, and report validity through the existing `onValidityChange` so Run is disabled on compile errors
- [x] 4.4 Confirm "Raw (PK/SK)" mode renders the current builder verbatim (no regression to index/PK/SK/filter UI); switching raw↔model preserves `modelSelection` (params survive the round-trip) and seeds raw from the last compiled `query`
- [x] 4.5 Component test: fill params → switch to raw → switch back → entity/access-pattern/params intact and compiled query unchanged

## 5. Docs & verification

- [x] 5.1 Document the `dynamo_model` doc format and `dynamo/tables/<table>/models/` layout in `README.md` (Context folders section) and `docs/context-folder-example/` with a sample STD model
- [x] 5.2 Manual verification against a real STD table: author 2 model docs by hand, confirm the toggle appears, select entity + access pattern, fill params (full and partial), and verify the issued Query matches raw mode
- [x] 5.3 Confirm a non-STD Dynamo table shows no toggle and behaves exactly as before
