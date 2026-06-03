## ADDED Requirements

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
