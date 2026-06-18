# dynamo-model-ai-inspector Specification

## Purpose
TBD - created by archiving change dynamo-model-ai-inspector. Update Purpose after archive.
## Requirements
### Requirement: Repo inspection is a CLI-provider-only AI task

The system SHALL expose a command `ai_inspect_models(connection_id, table)` that drives an AI agent to inspect the project source repo and propose `dynamo_model` drafts for the given table. The task SHALL run only on providers whose `Capabilities.can_read_files` is true (the CLI providers); when the active provider cannot read files, the command SHALL refuse with a clear signal and the UI entry point SHALL be disabled with an explanatory tooltip. The task SHALL reuse the provider spawn and `ChatDelta`/tool-call streaming machinery but MUST run with its working directory set to the configured project source path, not the context folder, and MUST NOT route through the SQL-generation chat command.

#### Scenario: API-only provider cannot inspect

- **WHEN** `ai_inspect_models` is invoked while the active provider's `can_read_files` is false
- **THEN** the command refuses with a clear signal identifying the provider as unable to read files, and no agent is spawned

#### Scenario: CLI provider inspects with the repo as working directory

- **WHEN** `ai_inspect_models` runs on a CLI provider with a configured project source path
- **THEN** the agent is spawned with its working directory set to that path and an inspector system prompt (not the SQL-generation prompt)

#### Scenario: Inspection requires a configured project source path

- **WHEN** `ai_inspect_models` is invoked and no `project_source_path` is configured for the connection's context folder
- **THEN** the command returns a clear error indicating the project source path is unset, and the UI prompts the user to choose one

### Requirement: Structured model proposals with provenance

The inspector SHALL return its results by calling a structured tool `propose_models` whose payload is a list of proposed models. Each proposed model MUST carry the editor draft fields (`name`, a non-empty `access_patterns` list, optional Markdown `body`) and AI review metadata: a per-model `confidence`, a `provenance` list of `{ file, lines?, reason }` entries identifying where in the repo the entity was inferred, and a `warnings` list. The owning table MUST NOT appear as `physical_table` inside any proposed draft (it is derived from location at save time). The AI review metadata is for review only and MUST NOT be written into the saved doc.

#### Scenario: A proposal includes verifiable provenance

- **WHEN** the inspector identifies an entity defined by a class exposing `PK()`/`SK()` methods at `src/models/Order.ts`
- **THEN** the corresponding proposed model includes a `provenance` entry naming `src/models/Order.ts` (with a line range when available) and a reason, alongside its `name` and `access_patterns`

#### Scenario: Unmapped index surfaces as a warning, not an invented pattern

- **WHEN** the live `TableDescription` defines a GSI for which the inspector finds no corresponding usage in the repo
- **THEN** the proposal omits an access pattern for that GSI and records a warning naming it, rather than inventing a mapping

#### Scenario: AI metadata is dropped on save

- **WHEN** the user accepts a proposed model and it is saved
- **THEN** the written `dynamo_model` doc contains only the draft core fields (and no `confidence`, `provenance`, or `warnings`)

### Requirement: Proposals are reviewed before any write

Proposed models SHALL be presented in a review surface where each is shown with its confidence and clickable provenance and is individually editable, acceptable, or discardable. The inspector itself MUST NOT write files. Accepting a proposal SHALL route it through the model editor's validation gate and write path (`context_save_model`); a proposal that fails validation against the live `TableDescription` MUST NOT be savable until corrected.

#### Scenario: Accepting a valid proposal saves it

- **WHEN** the user accepts a proposed model whose access patterns all resolve against the live `TableDescription`
- **THEN** it is saved via the editor write path and becomes available in the "By model" selector

#### Scenario: An invalid proposal cannot be saved as-is

- **WHEN** a proposed model references an index absent from the `TableDescription`
- **THEN** the review surface blocks saving it and surfaces the validation error until the user edits the access pattern

#### Scenario: Discarding writes nothing

- **WHEN** the user discards a proposed model
- **THEN** it is removed from the review surface and nothing is written to disk

