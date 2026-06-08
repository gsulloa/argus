## 1. Backend: project_source_path in context.yaml

- [x] 1.1 Add get/set of `project_source_path` in the context folder's `context.yaml` via `ContextManifest.extras` (no new typed field; preserve other extras on write) in `src-tauri/src/modules/context/`
- [x] 1.2 Expose commands `context_get_project_source(connection_id)` and `context_set_project_source(connection_id, path)`; setting writes `context.yaml` atomically, preserving `schema_version`, `name`, and any other extras
- [x] 1.3 Unit tests: set then get round-trips an absolute path; unrelated extras are preserved across a set; a folder with no `project_source_path` returns `None` (not an error)

## 2. Backend: inspector AI task

- [x] 2.1 Add an inspector system-prompt builder (sibling to `build_cli_system_prompt` in `ai/types.rs`, not a modification): instructs the agent to read the repo at cwd, find DynamoDB entity definitions (key-composition methods `PK()`/`SK()`/`GSI1PK()`; ElectroDB / dynamodb-toolbox schemas), map them to access patterns over the supplied `TableDescription` indexes, and return results ONLY via the `propose_models` tool; forbid writing files / running code / executing AWS/DB commands (decision D6)
- [x] 2.2 Define the `propose_models(models: InspectedModel[])` structured tool whose schema is the draft contract (`name`, `access_patterns[]`, `body?`) plus AI metadata (`confidence`, `provenance[]`, `warnings[]`) (decision D4/D5)
- [x] 2.3 Add `ai_inspect_models(connection_id, table)` in `ai/commands.rs`: resolve the active provider, **gate on `Capabilities.can_read_files`** (error/clear signal if false), resolve `project_source_path` (error if unset), spawn the CLI provider with `cwd = project_source_path` and the inspector prompt, pass the live `TableDescription` as context, and stream `ChatDelta`/tool-call events via the existing `drive_stream` (decision D1/D2)
- [x] 2.4 Parse the `propose_models` tool-call payload into typed `InspectedModel`s and surface them to the front end over the stream channel (the table being inspected travels as context, never as `physical_table` inside a draft)
- [x] 2.5 Backend tests: `can_read_files=false` provider → inspection rejected with a clear signal; unset `project_source_path` → clear error; a fixture repo with a class exposing `PK()`/`SK()` yields a `propose_models` call mapping to the table's indexes (provider mockable at the spawn boundary)

## 3. Frontend: project path + entry point

- [x] 3.1 Add a "Generate models with AI ✨" entry point in the data-view "By model" area; disable it with an explanatory tooltip when the active provider's `can_read_files` is false (decision D2)
- [x] 3.2 First-run flow: when `project_source_path` is unset, open a directory picker, persist via `context_set_project_source`, and offer to re-choose later
- [x] 3.3 API wrapper for `ai_inspect_models` that subscribes to the stream channel and accumulates `propose_models` results (reuse the chat tool-call streaming wiring)

## 4. Frontend: review-and-save surface

- [x] 4.1 Build a review surface (on the `dynamo-model-editor` UI) listing proposed models, each with its `confidence` and clickable `provenance` (`file:lines` open the source) and any `warnings`
- [x] 4.2 Each proposed model is editable in the editor form and individually accept / edit / discard; accepted drafts pass through the editor validation gate and save via `context_save_model`; AI metadata is dropped at save (decision D5/D7)
- [x] 4.3 Show a resolved/unresolved badge from the validation gate alongside the model-reported confidence (open question default)
- [x] 4.4 Component test: a streamed proposal renders with provenance links; accepting a valid model saves it and it appears in the selector; a proposal that fails validation cannot be saved until edited; discard removes it without writing

## 5. Docs & verification

- [x] 5.1 Update `README.md` "AI providers" to document the repo inspector: CLI-only, the `project_source_path` setting, and that proposals are reviewed before saving
- [ ] 5.2 Manual verification against a real STD repo (e.g. an ElectroDB project): point at the repo, run inspection for a table, verify provenance links resolve to the right source, edit one proposal, save, and query by the resulting model
- [ ] 5.3 Confirm an API-only provider disables the action with a tooltip, and that an unset/wrong `project_source_path` is handled with clear guidance
