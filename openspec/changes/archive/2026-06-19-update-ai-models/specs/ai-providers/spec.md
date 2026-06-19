## ADDED Requirements

### Requirement: Supported model sets

Each provider's `Capabilities` MUST advertise the following current model sets,
defined as the constants in `src-tauri/src/modules/ai/caps.rs`. Every
`default_model` MUST be the first id listed and MUST be a member of the provider's
`available_models`.

- **Claude CLI** (`ClaudeCli`): default `claude-opus-4-8`; available
  `[claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5]`.
- **Anthropic API** (`AnthropicApi`): default `claude-opus-4-8`; available
  `[claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5]`.
- **Codex CLI** (`CodexCli`): default `gpt-5.1`; available
  `[gpt-5.1, gpt-5.1-codex]`.
- **OpenAI API** (`OpenAiApi`): default `gpt-5.1`; available
  `[gpt-5.1, gpt-5.1-mini, gpt-4o]`.

The `context_window_for(model)` helper MUST return 200000 for every Claude model
and every `gpt-5.1*` model, 128000 for `gpt-4o`, and a conservative default for
any unrecognised id.

#### Scenario: Claude providers default to Opus 4.8

- **WHEN** `ClaudeCli::capabilities()` or `AnthropicApi::capabilities()` is read
- **THEN** `default_model` is `"claude-opus-4-8"`
- **AND** `available_models` equals `["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]`

#### Scenario: OpenAI providers expose the gpt-5.1 family

- **WHEN** `CodexCli::capabilities()` is read
- **THEN** `default_model` is `"gpt-5.1"` and `available_models` equals `["gpt-5.1", "gpt-5.1-codex"]`
- **WHEN** `OpenAiApi::capabilities()` is read
- **THEN** `default_model` is `"gpt-5.1"` and `available_models` equals `["gpt-5.1", "gpt-5.1-mini", "gpt-4o"]`

#### Scenario: Retired ids are no longer advertised

- **WHEN** any provider's `available_models` is read
- **THEN** none of `claude-opus-4-7`, `gpt-4o-mini`, `gpt-4-turbo`, `o3-mini` appears

#### Scenario: New ids have correct context windows

- **WHEN** `context_window_for("claude-opus-4-8")` or `context_window_for("gpt-5.1-mini")` is called
- **THEN** the result is `200000`
- **WHEN** `context_window_for("gpt-4o")` is called
- **THEN** the result is `128000`

### Requirement: Persisted model fallback at resolution

Model resolution MUST treat a persisted model id that is absent from the
provider's current `available_models` as unset, falling back to the provider's
`default_model`. This applies whether the id comes from the global
`ai_settings.<provider>_model` column or an `ai_connection_overrides.model` value,
and the fallback MUST happen before a provider instance is built, so generation
never fails solely because a previously valid model id was retired from the list.

This requirement does NOT relax the `generate_sql` contract: a `model: Some(s)`
passed directly into `generate_sql` whose value is absent from `available_models`
still MUST be rejected with `AppError::Validation`.

#### Scenario: Global default model no longer offered falls back

- **GIVEN** `ai_settings.default_provider = "openai-api"` and `ai_settings.openai_api_model = "gpt-4o-mini"`
- **WHEN** the model for `OpenAiApi` is resolved for generation
- **THEN** the resolved model is `"gpt-5.1"` (the provider default)
- **AND** generation proceeds without an `"unsupported model"` error

#### Scenario: Per-connection override no longer offered falls back

- **GIVEN** an `ai_connection_overrides` row with `provider_id = "anthropic-api"` and `model = "claude-opus-4-7"`
- **WHEN** the model for that connection is resolved
- **THEN** the resolved model is `"claude-opus-4-8"`

#### Scenario: Still-valid persisted model is preserved

- **GIVEN** `ai_settings.anthropic_api_model = "claude-sonnet-4-6"`
- **WHEN** the model for `AnthropicApi` is resolved
- **THEN** the resolved model is `"claude-sonnet-4-6"`
