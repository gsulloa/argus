## ADDED Requirements

### Requirement: Provider trait and identity

The Rust module `src-tauri/src/modules/ai/` SHALL expose a public trait `AiProvider` and an enum `ProviderId` whose variants identify exactly the four supported providers: `ClaudeCli`, `CodexCli`, `AnthropicApi`, `OpenAiApi`. `ProviderId` MUST serialise to the kebab-case strings `"claude-cli"`, `"codex-cli"`, `"anthropic-api"`, `"openai-api"` for use in sqlite, JSON, and frontend types. The trait MUST be object-safe (`dyn AiProvider`) and MUST require `Send + Sync`.

The trait MUST declare at minimum:
- `fn id(&self) -> ProviderId`
- `fn capabilities(&self) -> Capabilities`
- `async fn validate(&self) -> ValidationResult`
- `async fn generate_sql(&self, req: GenerateRequest) -> AppResult<GenerateStream>`

#### Scenario: ProviderId round-trips through JSON

- **WHEN** `serde_json::to_string(&ProviderId::ClaudeCli)` is called
- **THEN** the result is the string `"claude-cli"` (including surrounding quotes)
- **AND** `serde_json::from_str::<ProviderId>("\"claude-cli\"")` returns `Ok(ProviderId::ClaudeCli)`

#### Scenario: Trait is object-safe

- **WHEN** Rust code constructs a `Box<dyn AiProvider>` holding any of the four concrete implementations
- **THEN** the code compiles and runs without monomorphisation errors

### Requirement: Capability advertising

The `Capabilities` struct returned by each provider MUST declare:
- `can_read_files: bool` — `true` for `ClaudeCli` and `CodexCli`; `false` for both API providers.
- `supports_streaming: bool` — `true` for all four providers (CLIs stream stdout, APIs support SSE even if v1 doesn't surface it).
- `requires_api_key: bool` — `false` for CLIs; `true` for APIs.
- `default_model: &'static str` — non-empty.
- `available_models: &'static [&'static str]` — non-empty, MUST contain `default_model`.

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

### Requirement: Provider validation with bounded latency

Each provider MUST implement `validate() -> ValidationResult` returning one of:
- `Ready` — the provider is usable.
- `Missing { hint: String }` — required binary or key is absent. `hint` MUST be a single human-readable sentence indicating remediation.
- `Misconfigured { reason: String }` — present but failing (wrong key, outdated CLI, network error). `reason` MUST describe what failed.

Validation MUST complete within 3 seconds. If a CLI probe (`<cli> --version`) exceeds 3 seconds, validation MUST return `Missing { hint: "<cli> command did not respond within 3 seconds" }` and the spawned process MUST be killed.

API providers MUST validate by issuing a minimal probe request (e.g. `max_tokens=1`) against the provider's API using the stored key. A non-2xx response with status `401` or `403` MUST yield `Misconfigured { reason: "API key rejected" }`. Network errors MUST yield `Misconfigured { reason: "network unreachable: …" }`.

#### Scenario: Claude CLI present and working

- **GIVEN** `claude` is on `$PATH` and `claude --version` succeeds within 3 seconds
- **WHEN** `ClaudeCli::validate()` is called
- **THEN** the result is `ValidationResult::Ready`

#### Scenario: Claude CLI missing from PATH

- **GIVEN** no `claude` binary exists on `$PATH`
- **WHEN** `ClaudeCli::validate()` is called
- **THEN** the result is `ValidationResult::Missing` with a hint mentioning installing `claude` or the PATH

#### Scenario: Anthropic API key absent

- **GIVEN** no value exists in the keyring under `("argus", "ai:anthropic")`
- **WHEN** `AnthropicApi::validate()` is called
- **THEN** the result is `ValidationResult::Missing` with a hint mentioning entering an API key

#### Scenario: Anthropic API key invalid

- **GIVEN** a value exists under `("argus", "ai:anthropic")` but the Anthropic API rejects it with HTTP 401
- **WHEN** `AnthropicApi::validate()` is called
- **THEN** the result is `ValidationResult::Misconfigured` with reason `"API key rejected"`

#### Scenario: CLI hangs past timeout

- **GIVEN** `claude --version` does not return within 3 seconds (simulated by spawning a sleep)
- **WHEN** `ClaudeCli::validate()` is called
- **THEN** the result is `ValidationResult::Missing` with a hint mentioning the timeout
- **AND** the spawned child process is killed

### Requirement: GenerateRequest and stream contract

The struct `GenerateRequest` MUST contain:
- `prompt: String` — the user's natural-language description.
- `context_path: Option<PathBuf>` — passed to CLIs as `current_dir`; ignored by APIs.
- `context_payload: AiPayload` — the existing payload from `modules::context::ai`; embedded by APIs in the system prompt; ignored by CLIs.
- `model: Option<String>` — `None` means "use provider default"; a `Some(s)` value MUST be present in the provider's `available_models` list or the provider MUST return `AppError::Validation { message: "unsupported model: …" }` before spawning anything.

The `GenerateStream` type alias MUST resolve to `Pin<Box<dyn Stream<Item = AppResult<GenerateDelta>> + Send>>`. `GenerateDelta` MUST be an enum with at least `Text(String)` and `Done { finish_reason: Option<String> }` variants. A successful generation MUST emit zero or more `Text` items followed by exactly one `Done`. An error MUST be yielded as `Err(...)` and MUST terminate the stream.

#### Scenario: Stream emits Done as final item on success

- **WHEN** any provider's `generate_sql` runs to completion successfully
- **THEN** the last item yielded is `Ok(GenerateDelta::Done { … })`
- **AND** no further items follow

#### Scenario: Unsupported model rejected before spawning

- **WHEN** `generate_sql` is called with `model: Some("gpt-9000")` against `AnthropicApi`
- **THEN** the call returns `Err(AppError::Validation { message })` where `message` mentions the unsupported model
- **AND** no HTTP request is made

### Requirement: CLI providers spawn with context_path as working directory

`ClaudeCli` and `CodexCli` MUST spawn their underlying binary using `tokio::process::Command` with:
- `current_dir = req.context_path` when `Some`, otherwise the system temp directory (`std::env::temp_dir()`).
- `stdout` and `stderr` piped.
- The provider-specific non-interactive flag (e.g. `-p` for Claude Code's print mode; the equivalent for Codex CLI determined at implementation time).
- The prompt passed verbatim (no shell interpolation; argument vector form).
- `--model <model>` appended only when `req.model` is `Some`.

The provider MUST stream stdout lines as `GenerateDelta::Text` items as they arrive (no buffering until exit). Non-zero exit codes MUST be surfaced as `AppError::Internal` with the captured stderr included in the message.

#### Scenario: Claude CLI runs in context_path

- **GIVEN** `req.context_path = Some("/Users/me/billing/argus-ctx")` and the user has a context folder there
- **WHEN** `ClaudeCli::generate_sql(req)` is called
- **THEN** the spawned `claude` process has `current_dir` equal to that path
- **AND** the prompt is passed as a single argument (no shell)

#### Scenario: CLI failure surfaces stderr

- **GIVEN** the CLI exits with a non-zero status and prints `"error: rate limit"` to stderr
- **WHEN** the stream is consumed
- **THEN** the final item is `Err(AppError::Internal(message))` where `message` contains `"error: rate limit"`

### Requirement: API providers embed context payload in the system prompt

`AnthropicApi` and `OpenAiApi` MUST construct an HTTPS request to their respective endpoints (`/v1/messages` and `/v1/chat/completions`) with:
- The API key read from the keyring (`("argus", "ai:<provider>")`) at call time.
- A system prompt that begins with a short instruction ("Generate SQL for the user's request. Respond with only a SQL block, no prose.") and embeds the JSON-serialised `context_payload` in a fenced code block.
- The user's `prompt` as the single user message.
- `model` set to `req.model.clone().unwrap_or(default_model.to_string())`.
- `max_tokens` set to a sane default (e.g. 4096).

The provider MUST NOT include any other tools, attachments, or files. After receiving the response, the provider MUST attempt to extract the first fenced SQL block from the assistant's reply; if no fenced block is found the raw reply text MUST be returned as a single `Text` delta. Either way, exactly one `Done` follows.

#### Scenario: Anthropic API sees context in system prompt

- **GIVEN** a non-empty `context_payload` with two objects and one query
- **WHEN** `AnthropicApi::generate_sql(req)` is called
- **THEN** the HTTPS request body contains the serialised payload inside the `system` field
- **AND** the request body's `messages` field contains exactly one entry with `role: "user"` and `content` equal to `req.prompt`

#### Scenario: API key read fresh per call

- **GIVEN** the user updates the Anthropic key, then immediately calls `generate_sql`
- **WHEN** the request is built
- **THEN** the new key value is read from the keyring (not a cached value from app start)

#### Scenario: Fenced block extraction

- **GIVEN** the model returns: `"Here is the SQL:\n\n\`\`\`sql\nSELECT 1;\n\`\`\`\n"`
- **WHEN** the response is parsed
- **THEN** the stream yields `Text("SELECT 1;")` followed by `Done`

#### Scenario: No fenced block falls back to raw text

- **GIVEN** the model returns: `"SELECT 1;"` with no fence
- **WHEN** the response is parsed
- **THEN** the stream yields `Text("SELECT 1;")` followed by `Done`

### Requirement: Provider factory builds on demand

The module SHALL expose `fn build(id: ProviderId, settings: &AiSettings, secrets: &SecretsStore) -> AppResult<Box<dyn AiProvider>>` that constructs a provider value parameterised by current settings (e.g. configured model, current API key). The factory MUST NOT cache providers globally — each call MUST construct a fresh instance so that settings or key changes take effect on the next call.

#### Scenario: Factory returns matching provider

- **WHEN** `build(ProviderId::OpenAiApi, settings, secrets)` is called
- **THEN** the returned trait object's `id()` is `ProviderId::OpenAiApi`

#### Scenario: Settings change picked up on next call

- **GIVEN** the user changes the configured Anthropic model from `claude-opus-4-7` to `claude-sonnet-4-6`
- **WHEN** `build(ProviderId::AnthropicApi, …)` is called twice (before and after the change)
- **THEN** the second call's provider reports the new default model when no per-request override is given

### Requirement: Settings persistence

The migration `0006_ai_settings.sql` SHALL add:
- A singleton table `ai_settings` keyed on `id INTEGER PRIMARY KEY CHECK (id = 1)` storing `default_provider TEXT NULL`, `claude_cli_model TEXT NULL`, `codex_cli_model TEXT NULL`, `anthropic_api_model TEXT NULL`, `openai_api_model TEXT NULL`, `updated_at TEXT NOT NULL`.
- A per-connection override table `ai_connection_overrides (connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE, provider_id TEXT NOT NULL, model TEXT NULL)`.

The Rust API `AiSettings::resolve(connection_id: Option<Uuid>) -> ResolvedProviderConfig` MUST:
1. If `connection_id` is provided AND a row exists in `ai_connection_overrides`, return that provider and model.
2. Otherwise, if `ai_settings.default_provider` is `NULL`, return `Err(AppError::Validation { message: "no AI provider configured" })`.
3. Otherwise, return the default provider plus its configured model (or the provider's compiled default if the column is `NULL`).

API keys MUST live in the keyring under accounts `ai:anthropic` and `ai:openai` with service `"argus"`. The sqlite settings rows MUST NOT contain key material.

#### Scenario: Connection override wins over global default

- **GIVEN** `ai_settings.default_provider = "openai-api"` and an `ai_connection_overrides` row with `connection_id = X, provider_id = "claude-cli"`
- **WHEN** `resolve(Some(X))` is called
- **THEN** the result has `provider_id = ClaudeCli`

#### Scenario: Global default used when no override

- **GIVEN** `ai_settings.default_provider = "claude-cli"` and no override row for connection Y
- **WHEN** `resolve(Some(Y))` is called
- **THEN** the result has `provider_id = ClaudeCli`

#### Scenario: Unconfigured installation rejected

- **GIVEN** `ai_settings.default_provider` is `NULL` and no overrides exist
- **WHEN** `resolve(None)` is called
- **THEN** the result is `Err(AppError::Validation { message: "no AI provider configured" })`

### Requirement: Tauri commands surface the trait

The crate MUST register the following Tauri commands in `lib.rs`:
- `ai_list_providers() -> Vec<{ id: ProviderId, capabilities: Capabilities, validation: ValidationResult }>` — runs validation for all four providers concurrently with a 3s timeout each and returns the results.
- `ai_validate_provider(id: ProviderId) -> ValidationResult` — re-runs validation for a single provider, bypassing the validation cache.
- `ai_get_settings() -> AiSettingsView` — returns the current settings row plus per-connection overrides plus per-provider key-present booleans.
- `ai_set_settings(settings: AiSettingsInput) -> ()` — updates the singleton row and the override table; MUST validate that `default_provider` matches a known `ProviderId`.
- `ai_set_api_key(provider: ProviderId, key: String) -> ()` — stores the key in the keyring; rejects providers whose `requires_api_key` capability is `false`.
- `ai_delete_api_key(provider: ProviderId) -> ()` — removes the entry from the keyring; succeeds if the entry was already absent.
- `ai_generate_sql(prompt: String, context_path: Option<String>, payload: AiPayload, connection_id: Option<Uuid>, model: Option<String>) -> String` — resolves the provider via `AiSettings`, calls `generate_sql`, collects the stream, and returns the concatenated text.

All commands MUST return `AppResult<T>` and MUST follow the existing module convention of being declared in `src-tauri/src/modules/ai/commands.rs`.

#### Scenario: ai_list_providers includes all four

- **WHEN** the frontend calls `ai_list_providers`
- **THEN** the returned array has exactly four entries
- **AND** each entry's `id` is one of the four `ProviderId` values
- **AND** the entries appear in a stable order

#### Scenario: ai_set_api_key rejects CLI providers

- **WHEN** the frontend calls `ai_set_api_key(ProviderId::ClaudeCli, "x")`
- **THEN** the call returns `Err(AppError::Validation { message })` where `message` mentions that CLI providers do not accept API keys
- **AND** no keyring write occurs

#### Scenario: ai_generate_sql resolves provider from settings

- **GIVEN** the default provider is `OpenAiApi` with a valid API key configured
- **WHEN** `ai_generate_sql(prompt, None, empty_payload, None, None)` is called
- **THEN** an HTTPS request is made to OpenAI
- **AND** the response text is returned as the command result

### Requirement: Validation result caching

A `ValidationCache` MUST be stored in app state (`Mutex<HashMap<ProviderId, (ValidationResult, Instant)>>`) with a 60-second TTL. `ai_list_providers` MUST consult the cache and return cached entries when fresh. `ai_validate_provider` MUST bypass and overwrite the cache. Any call to `ai_set_api_key`, `ai_delete_api_key`, or `ai_set_settings` MUST invalidate the cache.

#### Scenario: Fresh cache hit avoids network probe

- **GIVEN** `AnthropicApi` was validated successfully 10 seconds ago
- **WHEN** `ai_list_providers` is called again
- **THEN** no HTTPS probe is sent to api.anthropic.com
- **AND** the returned entry for `AnthropicApi` reports `Ready`

#### Scenario: Setting an API key invalidates the cache

- **GIVEN** `AnthropicApi` was previously `Misconfigured { reason: "API key rejected" }`
- **WHEN** `ai_set_api_key(AnthropicApi, "new-key")` is called
- **THEN** the cache entry for `AnthropicApi` is removed
- **AND** the next `ai_list_providers` call re-probes the API
