## ADDED Requirements

### Requirement: Provider model listing with dynamic discovery

Each provider MUST expose a way to resolve its available models at runtime. The `AiProvider` trait SHALL declare `async fn list_models(&self) -> ModelListing`, returning a `ModelListing` struct containing:
- `models: Vec<String>` — the effective, ordered list of usable model IDs (never empty; MUST contain the provider default).
- `source: ModelSource` — one of `Provider`, `Cache`, `Fallback` (serialised kebab-case as `"provider"`, `"cache"`, `"fallback"`).
- `refreshed_at: Option<i64>` — unix-millis timestamp when the list was fetched from the provider (`None` when the list is the curated fallback).
- `error: Option<String>` — a single human-readable sentence describing why dynamic discovery failed, present only when `source` is `Fallback` and a fetch was attempted.

API providers (`AnthropicApi`, `OpenAiApi`) MUST attempt a live fetch (see "API model discovery via /v1/models"). CLI providers (`ClaudeCli`, `CodexCli`) MUST return the curated fallback list with `source: Fallback` and `error: None` (no discovery command exists yet).

#### Scenario: Effective list always contains the default

- **WHEN** any provider's `list_models()` resolves
- **THEN** `models` is non-empty
- **AND** `models` contains the provider's `default_model`

#### Scenario: CLI provider returns curated fallback

- **WHEN** `ClaudeCli::list_models()` or `CodexCli::list_models()` is called
- **THEN** `source` is `Fallback`
- **AND** `error` is `None`
- **AND** `models` equals the curated array for that provider

### Requirement: API model discovery via /v1/models

`AnthropicApi::list_models()` MUST issue `GET https://api.anthropic.com/v1/models` with the stored key (`x-api-key`, `anthropic-version: 2023-06-01`); `OpenAiApi::list_models()` MUST issue `GET https://api.openai.com/v1/models` with `Authorization: Bearer <key>`. Each request MUST complete within a 3-second timeout. On a 2xx response, the provider MUST parse the returned model IDs, filter to chat-capable IDs where the provider response allows such distinction, and return them with `source: Provider` and `refreshed_at` set to now.

When the key is absent, the request times out, returns a non-2xx status, or the network is unreachable, the provider MUST return the curated fallback list with `source: Fallback`, `refreshed_at: None`, and `error` set to a sentence describing the failure (e.g. `"no API key stored"`, `"Anthropic model list request timed out"`, `"API key rejected"`, `"network unreachable: …"`). The curated fallback MUST NOT be dropped or emptied on any failure.

#### Scenario: Successful discovery from provider

- **GIVEN** a valid key is stored for `AnthropicApi` and `GET /v1/models` returns 200 with a list of model IDs
- **WHEN** `AnthropicApi::list_models()` is called
- **THEN** `source` is `Provider`
- **AND** `models` contains the IDs returned by the API
- **AND** `refreshed_at` is a non-null timestamp

#### Scenario: No credentials falls back to curated list

- **GIVEN** no key is stored for `OpenAiApi`
- **WHEN** `OpenAiApi::list_models()` is called
- **THEN** no HTTP request is made
- **AND** `source` is `Fallback`
- **AND** `models` equals the curated OpenAI array
- **AND** `error` mentions the missing key

#### Scenario: Discovery timeout falls back with error

- **GIVEN** a key is stored for `AnthropicApi` but `GET /v1/models` does not respond within 3 seconds
- **WHEN** `AnthropicApi::list_models()` is called
- **THEN** `source` is `Fallback`
- **AND** `models` equals the curated Anthropic array
- **AND** `error` mentions the timeout

#### Scenario: Rejected key falls back with error

- **GIVEN** a key is stored for `OpenAiApi` but `GET /v1/models` returns HTTP 401
- **WHEN** `OpenAiApi::list_models()` is called
- **THEN** `source` is `Fallback`
- **AND** `error` mentions the key being rejected

### Requirement: TTL model cache

A `ModelCache` MUST cache each provider's `ModelListing` in memory with a TTL of at least 5 minutes, following the same locking pattern as the existing `ValidationCache`. `ai_list_providers` MUST serve a cached listing when present and unexpired rather than re-fetching. A cached listing served this way MUST report `source: Cache` (preserving the original `refreshed_at` and any `error`). The cache MUST expose `invalidate(provider)` and `invalidate_all()`, and settings changes and manual refreshes MUST invalidate the affected entry.

#### Scenario: Cached listing served without refetch

- **GIVEN** `AnthropicApi::list_models()` populated the cache within the TTL
- **WHEN** `ai_list_providers` is called again before the TTL expires
- **THEN** no new HTTP request is made
- **AND** the returned entry reports `source: Cache`
- **AND** the original `refreshed_at` is preserved

#### Scenario: Expired cache triggers refetch

- **GIVEN** a cached listing exists but is older than the TTL
- **WHEN** `ai_list_providers` is called
- **THEN** the provider is queried again and the cache is repopulated

### Requirement: Force refresh command

A Tauri command `ai_refresh_models(provider: ProviderId) -> ModelListing` MUST invalidate that provider's model-cache entry, perform a fresh `list_models()` fetch, store the result in the cache, and return it. It MUST NOT bypass the fallback behaviour: a failed fetch still returns the curated list with `source: Fallback` and an `error`.

#### Scenario: Refresh bypasses cache

- **GIVEN** a cached listing exists for `OpenAiApi`
- **WHEN** `ai_refresh_models("openai-api")` is called
- **THEN** the cache entry is invalidated first
- **AND** a fresh fetch is attempted
- **AND** the returned listing reflects the fresh fetch (or fallback on failure)

### Requirement: Model validation against the effective list

Model sanitisation and validation MUST consult the effective model list (dynamic when available, curated fallback otherwise) rather than only the static array. A model that is present in the effective list MUST be accepted; a model absent from the effective list MUST be treated as retired — resolved to `None` so the provider default is used, with a clear reason surfaced to callers — and MUST NOT crash the app. When no dynamic list is available, validation MUST fall back to the curated local list exactly as today.

#### Scenario: Model present in dynamic list is accepted

- **GIVEN** `AnthropicApi` dynamic discovery returned a list containing `"claude-newmodel-1"`
- **WHEN** settings save validates `anthropic_api_model = "claude-newmodel-1"`
- **THEN** the model is accepted and persisted

#### Scenario: Retired stored model resolves to default with reason

- **GIVEN** a stored model that is absent from both the dynamic list and the curated fallback
- **WHEN** the provider config is resolved for a chat/generation request
- **THEN** the resolved model is `None` (provider uses its default)
- **AND** a clear reason indicating the model is unavailable is surfaced, not a crash

#### Scenario: Validation uses fallback when discovery unavailable

- **GIVEN** no dynamic list is available for `OpenAiApi` (no key / offline)
- **WHEN** settings save validates `openai_api_model`
- **THEN** validation is performed against the curated OpenAI fallback array

### Requirement: Conservative context window with remote preference

`context_window(model)` MUST continue to return a conservative default (100,000 tokens) for unknown model IDs so budgeting never over-commits. When a provider's discovery response exposes a context-window/token-limit for a model, that metadata MAY be preferred over the static mapping for that model.

#### Scenario: Unknown model uses conservative default

- **WHEN** `context_window("some-unlisted-model")` is called
- **THEN** the result is the conservative fallback of 100,000 tokens

#### Scenario: Known model retains its mapped window

- **WHEN** `context_window("claude-opus-4-8")` is called
- **THEN** the result is 200,000 tokens
