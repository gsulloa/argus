## Context

The AI subsystem (`src-tauri/src/modules/ai/`) is built around the `AiProvider` trait with four implementations (`ClaudeCli`, `CodexCli`, `AnthropicApi`, `OpenAiApi`). Today it serves exactly one task — **SQL generation / chat**:

- CLI providers spawn their binary with `cwd = req.context_path` (the connection's **context folder**) and `--tools "Read Glob Grep"`, and a system prompt hardcoded as a SQL assistant that names the context folder as the working directory (`claude_cli.rs:98-115`, `types.rs:245-281`). Output is a fenced ```sql block.
- API providers have no disk access; context is serialised into the prompt as `AiPayload` (`anthropic_api.rs`, `types.rs:186-231`). `Capabilities.can_read_files` is `true` for the two CLI providers and `false` for the two API providers.
- Tool-call events stream to the front end via `drive_stream` (`commands.rs:312-387`), which emits each `ChatDelta` (including `ToolCallStarted`/`ToolCallFinished`) on a per-session channel.

The context folder is linked per connection (`connections.context_path`) and described by `context.yaml`, parsed into `ContextManifest { schema_version, name, #[serde(flatten)] extras }` (`context/types.rs:9-16`) — `extras` is an open, forward-compatible bag.

`dynamo-model-editor` (prerequisite change) defines the `ModelDraft` contract and a validated write path (`context_save_model`). This change adds a *producer* of those drafts that reads the project's source repo.

The critical gap: the repo to inspect (the user's **application source code**, where `PK()`/`SK()` or ElectroDB schemas live) is a different directory than the context folder. Nothing in the app points the AI at it today.

## Goals / Non-Goals

**Goals:**
- Let the user point the AI at their project repo and get proposed `dynamo_model` drafts for a table, mapped to PK/SK/GSI from the code.
- Make proposals **reviewable, not magic**: each carries the `file:lines` it was inferred from, a confidence, and explicit warnings for anything unmapped.
- Reuse the editor's validated write path — the inspector never writes files directly.
- Reuse the provider spawn/stream machinery without conflating the new task with SQL chat.

**Non-Goals:**
- Supporting the HTTP API providers for inspection (no disk access).
- Deterministic per-library parsers (ElectroDB/dynamodb-toolbox) — recognition is prompt-driven, expandable later.
- Auto-saving proposals without human review.
- Non-Dynamo engines, CloudWatch.

## Decisions

### D1. Inspection is a second AI task, with its own command — not `ai_chat_send`

A new command `ai_inspect_models(connection_id, table)` drives inspection. It reuses the provider's spawn + `ChatDelta` streaming and tool-call plumbing, but does **not** route through `ai_chat_send`, because that path's `context_path` is the cwd-and-it-means-the-context-folder. Inspection needs `cwd = project_source_path` and a different system prompt and output contract; overloading `ChatRequest.context_path` to sometimes mean "the repo" would corrupt the chat semantics.

- **Why:** the two tasks differ in all four of cwd, prompt, tools-target, and output. A separate command keeps each coherent and lets the chat path stay a SQL assistant.
- **Alternative considered:** add a `mode` to `ChatRequest`. Rejected — it muddies the most-used path and the shared field `context_path` would mean two things.

### D2. CLI providers only; gate on `can_read_files`

Inspection requires reading arbitrary files in the repo. CLI providers do this natively (their Read/Glob/Grep run in `cwd`). HTTP API providers would require serialising repo files into the payload — unbounded, context-limited, and the model can't ask for more files mid-turn. v1 supports CLI providers only; the "Generate with AI" action is disabled (with a tooltip) when the active provider's `can_read_files` is `false`.

- **Why:** matches the actual capability already modelled; avoids a degraded, expensive API-provider path that can't see the whole repo.

### D3. `project_source_path` lives in `context.yaml` extras

The path is stored in the context folder's `context.yaml` under `ContextManifest.extras` (`project_source_path: <abs path>`). No DB migration. The repo→models relationship is project-level, matching the context folder's scope; a folder shared across connections shares one source repo, which is correct for a single STD application. On first inspect with no path set, a file picker captures it and persists it; the user can re-choose later (repo moved).

- **Why:** `extras` is already forward-compatible; the scope matches the folder, not the connection. Storing it on the connection row would need a migration and could desync across connections sharing a folder.
- **Alternatives considered:** a connection-row column (migration + desync); inferring `../` of the context folder (folders are segregated under a neutral root that is **not** inside the app repo — the existing prompt's `../` "secondary source" does not apply here); transient per-invocation pick (re-pick friction every run).

### D4. Structured output via a `propose_models` tool-call, not text parsing

The inspector defines a tool `propose_models(models: ModelDraft[])` whose schema **is** the draft contract; the model calls it to deliver results. The CLI providers already emit tool-use events that `drive_stream` streams. This is robust against the model adding prose, and avoids a brittle "extract the last JSON fence" parse.

- **Why:** the streaming/tool-call infra already exists; a schema-enforced tool gives well-formed drafts. Text-block parsing (as `extract_fenced_block` does for SQL) is fragile for multi-record structured data.

- **Implementation note (deviation):** the CLI providers cannot register a custom `propose_models` tool without an MCP server (and inspection runs `--strict-mcp-config` with no MCP config). The realized contract therefore has the agent emit its results as a single fenced ```json block (`{ "models": [...] }`) matching the `InspectedModel[]` schema; the backend extracts and parses it (`parse_proposals`) and surfaces typed `InspectedModel`s to the front end as an `InspectDelta::Proposals` event. The schema-as-contract and the typed parse are preserved; only the transport differs from a literal tool-call. Revisit if/when an MCP-based tool path is added.

### D5. The draft contract = editor `ModelDraft` + ephemeral AI metadata

```
InspectedModel extends ModelDraft {
  // core (from dynamo-model-editor) — what gets written:
  name, access_patterns[], body?

  // AI-only, ephemeral — review UI only, never written to disk:
  confidence: number        // 0..1, per model
  provenance: { file: string, lines?: string, reason: string }[]
  warnings: string[]        // e.g. "GSI 'byActor' exists but no usage found in repo; omitted"
}
```
The inspector emits `physical_table` only as **context** alongside the call (the table being inspected), never inside a draft — consistent with D7-bis (table derived from location on write). Accepted drafts hand their **core** fields to `context_save_model`; the AI metadata is dropped at that boundary.

- **Why:** one shape for both producers means one validation + one write path (the editor's). Provenance is what makes a proposal auditable — clickable `file:lines` lets the user verify the mapping rather than trust it. Per-model confidence lets the UI foreground the uncertain ones. Warnings give the model an honest channel instead of inventing access patterns to cover GSIs it didn't understand.

### D6. Inspector system prompt — recognise patterns, don't execute; emit drafts only

A dedicated prompt builder (sibling to `build_cli_system_prompt`, not a modification of it) instructs the agent to: read the repo at `cwd`, find DynamoDB entity definitions (classes exposing key-composition methods like `PK()`/`SK()`/`GSI1PK()`; ElectroDB / dynamodb-toolbox declarative schemas), map each to access patterns over the indexes present in the supplied `TableDescription`, and return results **only** by calling `propose_models`. It is forbidden from writing files, running code, or executing AWS/DB commands (same restriction posture as the SQL prompt). The supported-pattern list is prompt content — expanding to new libraries/languages is a prompt edit, not new parser code.

- **Why:** the inspector is an LLM reading code, not a deterministic parser; the "supported libraries" surface is prompt scope. Keeping the write-forbidden posture prevents a CLI agent (which *can* Write) from bypassing the validated save path.

### D7. Proposals flow into the editor's review surface; nothing auto-saves

Streamed `propose_models` results render in a review surface built on the `dynamo-model-editor` UI: a list of proposed models, each with confidence and clickable provenance (`file:lines` open the source), each editable in the same form. The user accepts/edits/discards per model; accepted drafts save via `context_save_model` and run the editor's validation gate first (so a low-quality proposal still can't write an uncompilable doc).

- **Why:** review-before-write is the safety contract of the whole feature. Reusing the editor means proposals and hand-authored models share one validation + save path.

## Risks / Trade-offs

- **The repo path is wrong or stale** (repo moved). Mitigation: the path is re-choosable; inspection over an empty/irrelevant directory returns no/poor proposals with warnings, not silent garbage.
- **The model invents access patterns or mis-maps a GSI.** Mitigation: provenance makes every claim checkable; the editor's validation gate rejects access patterns that don't compile against the live `TableDescription`; warnings surface unmapped indexes; nothing auto-saves.
- **Large repos / context limits.** The CLI agent reads selectively via Glob/Grep rather than ingesting everything; if it can't determine a mapping it must emit a warning rather than guess. (No silent truncation — proposals are explicitly partial.)
- **Provider lacks disk access.** Mitigation: the action is disabled with an explanatory tooltip (D2); the user can switch to a CLI provider.
- **Inspector prompt drift vs the SQL prompt.** They are separate builders; changes to one don't affect the other.

## Migration Plan

Additive. Depends on `dynamo-model-editor` shipping first (the `ModelDraft` contract and `context_save_model`). `context.yaml` files without `project_source_path` are unaffected; the field is written only when the user picks a repo. No DB migration. Rollback = revert the code; a `project_source_path` left in `context.yaml` is inert to older builds (preserved opaquely by the `extras` flatten).

## Open Questions

- Should inspection target one table at a time (current design, `ai_inspect_models(table)`) or scan the whole repo and propose models for every table at once? Default: per-table, matching the data-view entry point; whole-repo can be a later affordance.
- Confidence is model-reported — do we also derive a heuristic signal (e.g. "all access-pattern indexes resolved against `TableDescription`")? Default: show the model's confidence plus a resolved/unresolved badge from the validation gate.
