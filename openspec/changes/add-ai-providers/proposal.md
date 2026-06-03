## Why

The `add-connection-context-folders` change shipped `context_ai_payload` — a serialised view of the linked context folder ready to feed to an AI — but Argus has no AI feature yet. Users describe SQL in natural language in their head, then write it by hand against a schema that the context folder already documents in machine-readable form. The gap closes when we connect "describe what you want" to "run it".

Doing this well means **not picking one AI vendor**. Some users have the `claude` CLI installed and authenticated; some prefer the `codex` CLI; some only have an Anthropic API key; some only OpenAI. The CLIs are agents and can read the context folder directly from disk; the APIs are one-shot completions and need the payload embedded. A single hard-coded provider would be a regret within weeks.

So this change introduces an **AI provider abstraction** (Strategy pattern) with four concrete implementations, plus the first concrete consumer: a "✨ Generate SQL" affordance in the Postgres query editor.

## What Changes

- Add a Rust `AiProvider` trait + four implementations: `ClaudeCli`, `CodexCli`, `AnthropicApi`, `OpenAiApi`.
- Add a `Capabilities` struct each provider advertises (`can_read_files`, `supports_streaming`, etc.) so the UI can branch without leaking provider identity.
- Add presence/validation: CLIs are probed (`which` + `--version`); APIs validate by trying a 1-token completion against the stored key.
- Store API keys in the existing keyring with new accounts (`ai:anthropic`, `ai:openai`); CLI providers need no secret.
- Store provider configuration globally (one default per install) with an optional per-connection override in v1. Persisted in the existing sqlite store under a new `ai_settings` table.
- Add a "✨" button to `QueryEditor.tsx` (Postgres) that opens a modal: textarea for natural-language prompt, provider dropdown (showing only providers that validated), model dropdown (defaults per provider, override available), Generate.
- Generate flow: backend builds a `GenerateRequest { prompt, context_path, context_payload, model }` and dispatches to the active provider. CLIs are spawned with `current_dir = context_path` so they can read the folder; APIs receive `context_payload` embedded in the system prompt.
- Add Tauri commands: `ai_list_providers`, `ai_validate_provider`, `ai_get_settings`, `ai_set_settings`, `ai_set_api_key`, `ai_delete_api_key`, `ai_generate_sql`.
- Add a settings panel (new entry in the command palette: "AI: Configure providers") for choosing default provider, default model per provider, and entering API keys.
- Trait method returns a stream internally (`Stream<Result<Delta>>`) from day one so future chat / streaming UI doesn't require a re-design; the v1 generate-SQL flow collects to a single string before returning.

## Capabilities

### New Capabilities
- `ai-providers`: The Rust trait, factory, presence detection, capabilities, API-key handling, configuration storage, and the four concrete provider implementations. Engine-agnostic — does not depend on Postgres/MySQL/etc.
- `ai-sql-generation`: The first user-facing consumer — natural-language to SQL inside the Postgres SQL editor, including the modal UX, provider/model dropdowns, and insert-into-editor behaviour.
- `ai-settings-panel`: Configuration UI for picking the default provider, per-provider model, and entering API keys. Lives behind a command-palette entry.

### Modified Capabilities
- `postgres-sql-editor`: Adds the "✨ Generate" affordance to the query editor toolbar. No change to existing run/save behaviour.

## Impact

- **New Rust module**: `src-tauri/src/modules/ai/` (trait, types, factory, four providers, commands).
- **New Frontend module**: `src/modules/ai/` (api wrappers, types, store, GenerateModal, SettingsPanel).
- **DB migration**: `0006_ai_settings.sql` — table for default provider, per-provider model, and per-connection overrides.
- **Keyring**: new accounts `ai:anthropic`, `ai:openai` (existing `keyring` dep, no new system requirement).
- **Cargo deps**: `reqwest` (likely already present; verify) for HTTPS calls; `tokio::process::Command` for CLI spawning (already in tokio). No new heavy dependencies anticipated.
- **Frontend deps**: none new — uses existing modal patterns from `ContextFolderRow` and `SyncReportModal`.
- **Command palette**: one new entry ("AI: Configure providers").
- **Postgres SQL editor toolbar**: one new button; non-breaking.
- **Scope explicitly excluded from v1** (deferred to follow-up changes): chat mode, explain-with-AI on schema nodes, streaming UI, MySQL/MSSQL/Dynamo editors (mechanical replication once Postgres is proven), provider cost / token accounting, tool-call protocol for APIs.
