## Why

The hardcoded model lists advertised by each AI provider have drifted behind the
models the underlying CLIs and APIs actually serve. Anthropic now defaults to
Opus 4.8, OpenAI's `gpt-5.1` family supersedes the `gpt-4o` line, and the Codex
CLI ships `gpt-5.1-codex`. Users picking a model in **AI: Configure providers**
are offered stale, in some cases retired, identifiers, and the default model
chosen for fresh installs is outdated.

## What Changes

- Update the four model-list constants in `src-tauri/src/modules/ai/caps.rs` to the
  current supported sets:
  - **Claude CLI**: default `claude-opus-4-8`; list `[claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5]`.
  - **Anthropic API**: default `claude-opus-4-8`; list `[claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5]`.
  - **Codex CLI**: default `gpt-5.1`; list `[gpt-5.1, gpt-5.1-codex]`.
  - **OpenAI API**: default `gpt-5.1`; list `[gpt-5.1, gpt-5.1-mini, gpt-4o]`.
- Update the context-window lookup in `caps.rs` so every new model id maps to a
  correct window (Claude family and `gpt-5.1` family → 200k; `gpt-4o` → 128k).
- **BREAKING (graceful):** Persisted settings may reference a model id that is no
  longer advertised (`claude-opus-4-7`, `gpt-4o-mini`, `gpt-4-turbo`, `o3-mini`).
  Add a fallback so a stored-but-unavailable model resolves to the provider's
  current `default_model` at generation time instead of failing with
  `"unsupported model"`, and so the settings dropdown shows the default selected
  rather than a missing entry.
- Update Rust and TypeScript tests/mocks that reference the retired model ids.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `ai-providers`: refine the model-set portion of capability advertising to the new
  supported lists, and add graceful fallback for a persisted model id that is not
  in the provider's current `available_models` (resolve to `default_model` rather
  than rejecting generation).
- `ai-settings-panel`: the model dropdown MUST fall back to the provider's
  `default_model` when the persisted model is no longer in `available_models`
  (updates an example scenario that referenced a now-retired id).

## Impact

- **Backend**: `src-tauri/src/modules/ai/caps.rs` (constants + context-window map);
  model-resolution path in `factory.rs` / provider `generate_sql` implementations
  (`anthropic_api.rs`, `openai_api.rs`, `claude_cli.rs`, `codex_cli.rs`) for the
  fallback; affected unit tests in `settings.rs`, `codex_cli.rs`, `openai_api.rs`.
- **Frontend**: `SettingsPanel.tsx` dropdown fallback behaviour; test mocks in
  `SettingsPanel.test.tsx` and `ChatPanel.test.tsx`.
- **Data**: no schema migration — `ai_settings` / `ai_connection_overrides` columns
  are unchanged; existing rows holding retired ids are tolerated via the fallback.
- **No API key or keychain changes.**
