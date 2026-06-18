## Why

Authoring `dynamo_model` docs — even through the editor (`dynamo-model-editor`) — still requires the user to know their Single-Table Design: which entities exist and how each maps to PK/SK/GSI templates. That knowledge already lives in the project's source code: classes with key-composition methods (`PK()`, `SK()`, `GSI1PK()`), or declarative schemas in libraries like ElectroDB / dynamodb-toolbox. This change adds the second path of issue #73: an **AI inspector** that reads the project repo, cross-references the live table schema, and proposes model drafts for the user to review and save.

It builds directly on `dynamo-model-editor`: the inspector does not write files. It produces the same `ModelDraft` the editor's form produces, surfaces them in the editor for human review, and they are saved through the editor's already-validated write path.

## What Changes

- Introduce a **second AI task type** — repo inspection — distinct from the existing SQL-generation chat. It reuses the `AiProvider` trait (spawn + stream `ChatDelta` + tool-call events) but with its own working directory (the project repo, not the context folder), its own system prompt (find STD entities → map to PK/SK/GSI), and structured output. A new command `ai_inspect_models(connection_id, table)` drives it.
- Add a **`project_source_path`** setting: the path to the user's application source repo to inspect. It is persisted in the context folder's `context.yaml` under its forward-compatible `extras` (no DB migration), scoped to the folder. On first inspect with no path set, a file picker captures it; the path can be re-chosen later.
- **CLI providers only** in v1. The inspector runs on Claude Code / Codex CLI (which read the repo from disk via their native Read/Glob/Grep tools); the HTTP API providers (Anthropic/OpenAI), which have no disk access, do not support it. Availability is gated on the existing `Capabilities.can_read_files`.
- The inspector returns model drafts as **structured tool-call output** conforming to a `ModelDraft[]` contract extended with AI-only review metadata: per-model `confidence`, `provenance` (the `file:lines` in the repo each entity was inferred from), and `warnings` (e.g. a GSI it could not map). The metadata is ephemeral — used in the review UI, never written to disk.
- The inspector is invoked from the data-view "By model" area ("Generate models with AI ✨"). Results open in the **editor's review surface**: each proposed model is shown with its confidence and clickable provenance; the user edits, accepts, or discards, and accepted drafts save through the `dynamo-model-editor` validated write path.

## Capabilities

### New Capabilities
- `dynamo-model-ai-inspector`: the repo-inspection AI task — the `ai_inspect_models` command, the inspector system prompt and working-directory contract, the structured `ModelDraft` + provenance/confidence/warnings output, CLI-provider gating, and the review-and-save flow into the editor.

### Modified Capabilities
- `connection-context-folders`: the context folder's `context.yaml` gains an optional `project_source_path` (stored in the manifest's forward-compatible `extras`), the source repo the AI inspector reads. Reading and writing it does not affect existing folders that omit it.

## Impact

- **Backend** (`src-tauri/src/modules/ai/`): a new inspector path that reuses the provider `spawn`/stream machinery but sets `cwd = project_source_path`, builds an inspector system prompt (not the SQL one in `types.rs:245`), passes the live `TableDescription` as context, and defines the `propose_models` structured tool. New `ai_inspect_models` command in `commands.rs`; gating via `Capabilities.can_read_files`.
- **Backend** (`src-tauri/src/modules/context/`): read/write `project_source_path` in `context.yaml` (`ContextManifest.extras`); a small command to get/set it.
- **Frontend** (`src/modules/dynamo/data-view/`): a "Generate with AI" entry point (disabled with a tooltip when the active provider can't read files), a first-run project-path picker, and a review surface that lists proposed `ModelDraft`s with confidence + clickable provenance, feeding accepted drafts into the `dynamo-model-editor` save path. Reuse the tool-call streaming already wired for chat.
- **Out of scope:** AI inspection for the HTTP API providers; deterministic (non-AI) parsers for specific libraries; languages/libraries beyond what the prompt can recognise (expandable later via prompt only); inspection for non-Dynamo engines; CloudWatch.
