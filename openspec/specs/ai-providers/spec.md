# ai-providers Specification

## Purpose
TBD - created by archiving change add-ai-providers. Update Purpose after archive.
## Requirements
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

### Requirement: AiProvider trait exposes a chat method

The `AiProvider` trait in `src-tauri/src/modules/ai/provider.rs` MUST add a new method:

```rust
async fn chat(&self, req: ChatRequest) -> AppResult<ChatStream>;
```

`ChatRequest` MUST contain:
- `turns: Vec<ChatTurn>` — full conversation history including the latest user turn (always non-empty; last entry is role User).
- `context_path: Option<PathBuf>` — passed to CLIs as `current_dir`; ignored by APIs.
- `context_payload: AiPayload` — embedded in the API providers' system prompt every turn; ignored by CLIs.
- `model: Option<String>` — `None` means use provider default; a `Some(s)` MUST be present in `available_models` or the provider MUST return `AppError::Validation { message: "unsupported model: …" }` before doing any work.
- `session_id: String` — opaque session identifier used by CLIs that support multi-turn resume; ignored by APIs.

`ChatTurn` MUST be:
```rust
pub struct ChatTurn {
    pub role: ChatRole,                       // User | Assistant
    pub content: String,
    pub tool_uses: Vec<ToolUseRecord>,        // empty for User turns; populated for Assistant turns
}
```

`ChatStream` MUST resolve to `Pin<Box<dyn Stream<Item = AppResult<ChatDelta>> + Send>>`. `ChatDelta` MUST be an enum with at minimum: `Text(String)`, `ToolCallStarted { id, name, input }`, `ToolCallFinished { id, output, is_error }`, `Status(String)`, `Done { finish_reason: Option<String> }`, `Error(String)`. A successful stream MUST end with exactly one `Done`. An errored stream MUST end with exactly one `Error` or yield an `Err(AppError)` and terminate.

#### Scenario: chat() returns a stream that ends with Done

- **WHEN** any provider's `chat()` is consumed to completion successfully
- **THEN** the final item is `Ok(ChatDelta::Done { … })`
- **AND** no items follow

#### Scenario: Unsupported model rejected before any work

- **WHEN** `chat()` is called with `model: Some("gpt-9000")` against `AnthropicApi`
- **THEN** `chat()` returns `Err(AppError::Validation { message })`
- **AND** no HTTP request is made and no child process is spawned

### Requirement: CLI providers parse structured output where supported

`ClaudeCli::chat` MUST spawn `claude` with `--output-format stream-json` (in addition to `-p`, `--model`, and `--resume <session_id>` when applicable). The provider MUST parse stdout line-by-line as JSON; each parsed event maps to a `ChatDelta` value per a documented table:

- `{ "type": "content_block_delta", "delta": { "type": "text_delta", "text": "…" } }` → `Text(text)`
- `{ "type": "tool_use", "id": "…", "name": "…", "input": {…} }` → `ToolCallStarted { id, name, input }`
- `{ "type": "tool_result", "tool_use_id": "…", "content": "…", "is_error": bool? }` → `ToolCallFinished { id: tool_use_id, output, is_error }`
- `{ "type": "message_stop", "stop_reason": "…" }` → `Done { finish_reason }`
- unknown event types → `Status("unhandled event: <type>")` (NOT a terminal error)

Lines that fail JSON parse MUST emit `Status("non-json line from claude: <truncated>")` and processing MUST continue.

`CodexCli::chat` MAY fall back to plain text streaming in v1: it spawns `codex exec <prompt-with-history>` (history flattened into the prompt body), streams stdout line-by-line as `Text(line)` deltas, and emits a single `Status("codex doesn't expose structured tool events yet")` on first turn so the UI can present an honest hint.

CLI providers MUST set `current_dir = req.context_path.unwrap_or(std::env::temp_dir())` on every turn.

#### Scenario: claude-cli emits tool-call events

- **GIVEN** `claude` emits a `tool_use` event for `Read` with input `{ "path": "manifest.json" }`
- **WHEN** the chat stream is consumed
- **THEN** a `ChatDelta::ToolCallStarted { name: "Read", input: { "path": "manifest.json" }, … }` is yielded

#### Scenario: claude-cli yields Done on message_stop

- **WHEN** `claude` emits `{ "type": "message_stop", "stop_reason": "end_turn" }`
- **THEN** the stream yields `ChatDelta::Done { finish_reason: Some("end_turn") }`
- **AND** no further items follow

#### Scenario: codex-cli falls back to plain text

- **WHEN** `codex exec` writes `"SELECT 1;"` to stdout
- **THEN** the stream yields `ChatDelta::Text("SELECT 1;")`
- **AND** on first turn a single `ChatDelta::Status` is yielded explaining the limitation

#### Scenario: CLI working directory respects context_path on every turn

- **GIVEN** a 3-turn chat with `context_path = Some("/ctx")`
- **WHEN** the third turn is sent
- **THEN** the spawned CLI process for that turn has `current_dir = "/ctx"`

### Requirement: API providers send full message history per turn

`AnthropicApi::chat` MUST construct an HTTPS request to `/v1/messages` with `messages` populated from `req.turns` (User and Assistant turns mapped 1:1) and `system` containing the existing context-payload-embedded prompt from `add-ai-providers`. `OpenAiApi::chat` MUST do the same against `/v1/chat/completions`, additionally inserting the system prompt as a leading `{ "role": "system", "content": … }` entry.

API providers MUST estimate token count of the serialised request (length / 4 is acceptable in v1) and, if it exceeds 80% of the model's documented context window, MUST drop the oldest non-system turns one at a time until the estimate fits. When any turns are dropped, the provider MUST emit `ChatDelta::Status("trimmed N old turns to fit context window")` before issuing the request.

The HTTP response is parsed as in v1: extract the first fenced code block via the existing `extract_fenced_block` helper. The response body MUST be yielded as a single `ChatDelta::Text(extracted)` followed by `ChatDelta::Done { finish_reason }` — the SSE streaming variant is still deferred.

API providers MUST NOT emit `ToolCallStarted` or `ToolCallFinished` events in v1; tool-use protocol is a separate change.

#### Scenario: Anthropic chat sends full history

- **GIVEN** `req.turns` contains User → Assistant → User
- **WHEN** `AnthropicApi::chat(req)` is called
- **THEN** the request body's `messages` array contains exactly those three entries in order
- **AND** the `system` field contains the serialised context payload

#### Scenario: Oldest turns trimmed on token overflow

- **GIVEN** `req.turns` contains 200 long turns whose estimated tokens exceed 80% of the model's context window
- **WHEN** `chat()` runs
- **THEN** a `ChatDelta::Status("trimmed N old turns to fit context window")` is emitted with N > 0
- **AND** the actual request omits the oldest N turns
- **AND** the most recent User turn is always present

#### Scenario: API providers don't emit tool-call events in v1

- **WHEN** `OpenAiApi::chat` runs to completion
- **THEN** zero `ToolCallStarted` or `ToolCallFinished` deltas are emitted
- **AND** the stream consists of `Text` deltas plus exactly one `Done`

### Requirement: Chat session registry

A `ChatSessionRegistry` MUST be stored in app state (`Mutex<HashMap<String, ChatSession>>`, keyed by session id). Each `ChatSession` holds the bound `ProviderId`, the connection id, the context path captured at session-open time, the conversation `turns`, and (if running) a `tokio::task::JoinHandle` for the in-flight turn.

The registry MUST evict the entry on `ai_chat_close(session_id)`. When `MAX_SESSIONS` (64) is exceeded the registry MUST evict the least-recently-used entry; the evicted session's in-flight task MUST be aborted.

#### Scenario: Registry stores active sessions

- **GIVEN** the frontend opens a chat with session id `"abc-123"`
- **WHEN** the user sends a turn
- **THEN** the registry contains an entry under `"abc-123"` with one User turn appended

#### Scenario: ai_chat_close drops the session

- **WHEN** `ai_chat_close("abc-123")` is invoked
- **THEN** the registry no longer contains that entry
- **AND** any in-flight task for that session is aborted

#### Scenario: LRU eviction when capacity exceeded

- **GIVEN** 64 sessions exist in the registry
- **WHEN** a 65th `ai_chat_send` for a new session id arrives
- **THEN** the least-recently-used existing session is evicted
- **AND** its in-flight task (if any) is aborted

### Requirement: Tauri commands surface the chat trait

The crate MUST register the following Tauri commands:

- `ai_chat_send(session_id: String, prompt: String, connection_id: Option<String>) -> ()` — appends a User turn to the session's history, resolves the bound provider (or resolves on first call when the session is new), spawns a Tokio task that drives the provider's `chat()` stream and emits `ai-chat-delta:<session_id>` events with `ChatDelta` payloads, returns `Ok(())` as soon as the task is spawned.
- `ai_chat_cancel(session_id: String) -> ()` — aborts the in-flight task for that session if any; idempotent if nothing is running.
- `ai_chat_close(session_id: String) -> ()` — aborts in-flight task (if any) and evicts the session from the registry.
- `ai_chat_history(session_id: String) -> Vec<ChatTurn>` — returns the current persisted turns; used by the frontend on tab remount in the future, no-op in v1.

The previously registered `ai_generate_sql` command from `add-ai-providers` MAY remain registered as a thin wrapper around `chat()` that collects text-only deltas into a single string; it has no frontend caller after this change and may be marked `#[deprecated]` for a follow-up cleanup.

#### Scenario: ai_chat_send spawns a task and emits events

- **WHEN** the frontend calls `ai_chat_send("abc", "hi", None)`
- **THEN** the call returns `Ok(())` promptly
- **AND** the frontend's listener on `ai-chat-delta:abc` receives one or more `ChatDelta` events followed by `Done`

#### Scenario: ai_chat_cancel kills CLI process

- **GIVEN** a `claude-cli` chat is mid-stream with a running child process
- **WHEN** `ai_chat_cancel(session_id)` is invoked
- **THEN** the task is aborted
- **AND** the child process is killed within 100ms (verified by absence in process list)
- **AND** a final `ChatDelta::Error("cancelled")` event is emitted before the channel closes

