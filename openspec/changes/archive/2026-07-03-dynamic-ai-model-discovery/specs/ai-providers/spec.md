## MODIFIED Requirements

### Requirement: Capability advertising

The `Capabilities` struct returned by each provider MUST declare:
- `can_read_files: bool` — `true` for `ClaudeCli` and `CodexCli`; `false` for both API providers.
- `supports_streaming: bool` — `true` for all four providers (CLIs stream stdout, APIs support SSE even if v1 doesn't surface it).
- `requires_api_key: bool` — `false` for CLIs; `true` for APIs.
- `default_model: &'static str` — non-empty.
- `available_models: &'static [&'static str]` — the curated local fallback list, non-empty, MUST contain `default_model`. This field is the safe fallback and is always populated regardless of dynamic discovery.

The effective, possibly-dynamic model list is NOT carried on `Capabilities`; it is resolved separately (see the `ai-model-discovery` capability and the `ProviderListEntry` model provenance below) so that `Capabilities` can remain a cheap, synchronous, static value.

Consumers (UI, factory) MUST branch on capabilities, not on `ProviderId`, when behaviour differs (e.g. "does this provider need an API key from the keyring").

#### Scenario: CLI providers advertise file access

- **WHEN** `ClaudeCli::capabilities()` or `CodexCli::capabilities()` is read
- **THEN** `can_read_files` is `true`
- **AND** `requires_api_key` is `false`

#### Scenario: API providers advertise key requirement

- **WHEN** `AnthropicApi::capabilities()` or `OpenAiApi::capabilities()` is read
- **THEN** `can_read_files` is `false`
- **AND** `requires_api_key` is `true`

#### Scenario: Default model is always in available list

- **WHEN** any provider's capabilities are read
- **THEN** `available_models.contains(&default_model)` is `true`

### Requirement: GenerateRequest and stream contract

The struct `GenerateRequest` MUST contain:
- `prompt: String` — the user's natural-language description.
- `context_path: Option<PathBuf>` — passed to CLIs as `current_dir`; ignored by APIs.
- `context_payload: AiPayload` — the existing payload from `modules::context::ai`; embedded by APIs in the system prompt; ignored by CLIs.
- `model: Option<String>` — `None` means "use provider default"; a `Some(s)` value MUST be present in the provider's **effective** model list (dynamic when available, curated fallback otherwise) or the provider MUST return `AppError::Validation { message: "unsupported model: …" }` before spawning anything.

The `GenerateStream` type alias MUST resolve to `Pin<Box<dyn Stream<Item = AppResult<GenerateDelta>> + Send>>`. `GenerateDelta` MUST be an enum with at least `Text(String)` and `Done { finish_reason: Option<String> }` variants. A successful generation MUST emit zero or more `Text` items followed by exactly one `Done`. An error MUST be yielded as `Err(...)` and MUST terminate the stream.

#### Scenario: Stream emits Done as final item on success

- **WHEN** any provider's `generate_sql` runs to completion successfully
- **THEN** the last item yielded is `Ok(GenerateDelta::Done { … })`
- **AND** no further items follow

#### Scenario: Unsupported model rejected before spawning

- **WHEN** `generate_sql` is called with a `model` that is absent from the effective model list against `AnthropicApi`
- **THEN** the call returns `Err(AppError::Validation { message })` where `message` mentions the unsupported model
- **AND** no HTTP request is made

## ADDED Requirements

### Requirement: ai_list_providers reports effective models and provenance

The `ai_list_providers` command MUST include, per provider entry, the effective model list and its provenance so the frontend can render an accurate dropdown and a source indicator. `ProviderListEntry` MUST carry a `models` field of shape `ModelListing` (see `ai-model-discovery`) with `models`, `source` (`provider`/`cache`/`fallback`), `refreshed_at`, and `error`. Resolving these lists MUST reuse the `ModelCache` (serving `source: cache` when unexpired) and MUST NOT block the command beyond the per-provider 3-second discovery timeout; a provider whose discovery fails still returns its curated fallback list.

The static `capabilities.available_models` field MUST continue to be present and populated with the curated fallback for backward compatibility.

#### Scenario: Entry carries effective models and source

- **WHEN** `ai_list_providers` is called
- **THEN** each returned entry includes a `models` object with a non-empty list and a `source` of `provider`, `cache`, or `fallback`

#### Scenario: Failing discovery still returns curated fallback

- **GIVEN** `OpenAiApi` discovery fails (no key or network error)
- **WHEN** `ai_list_providers` is called
- **THEN** that entry's `models.source` is `fallback`
- **AND** `models.models` equals the curated OpenAI array
- **AND** `capabilities.available_models` is still populated with the curated array
