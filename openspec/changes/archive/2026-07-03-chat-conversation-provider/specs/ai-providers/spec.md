## MODIFIED Requirements

### Requirement: Chat session registry

A `ChatSessionRegistry` MUST be stored in app state (`Mutex<HashMap<String, ChatSession>>`, keyed by session id). Each `ChatSession` holds the bound `ProviderId`, the connection id, the context path captured at session-open time, the conversation `turns`, and (if running) a `tokio::task::JoinHandle` for the in-flight turn.

The bound `ProviderId` is session-scoped and MAY change over the session's lifetime when a send supplies an explicit `provider_id` override that differs from the current binding. When the bound provider changes, the registry MUST update the bound `ProviderId` and MUST clear the session's provider-specific `provider_state` (e.g. `resume_id`, `codex_warning_shown`); the conversation `turns` MUST be preserved. An optional session model override MAY be carried per send and MUST NOT be persisted to `ai_settings` or `ai_connection_overrides`.

The registry MUST evict the entry on `ai_chat_close(session_id)`. When `MAX_SESSIONS` (64) is exceeded the registry MUST evict the least-recently-used entry; the evicted session's in-flight task MUST be aborted.

#### Scenario: Registry stores active sessions

- **GIVEN** the frontend opens a chat with session id `"abc-123"`
- **WHEN** the user sends a turn
- **THEN** the registry contains an entry under `"abc-123"` with one User turn appended

#### Scenario: Explicit provider override rebinds and keeps history

- **GIVEN** session `"abc-123"` is bound to `claude-cli` with 2 turns and a `resume_id` in `provider_state`
- **WHEN** `ai_chat_send("abc-123", prompt, conn, Some("anthropic-api"), None, …)` is invoked
- **THEN** the session's bound provider becomes `anthropic-api`
- **AND** the 2 existing turns are preserved and re-sent
- **AND** the previous provider's `resume_id`/`provider_state` is cleared

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

- `ai_chat_send(session_id: String, prompt: String, connection_id: Option<String>, provider_id: Option<String>, model: Option<String>) -> ()` — appends a User turn to the session's history, then resolves the provider with the precedence: (1) the explicit `provider_id` argument when present (binding or rebinding the session per the chat session registry rules); (2) otherwise the session's already-bound provider; (3) otherwise `AiSettings::resolve(...)` for a brand-new session. An explicit `model` argument, when present, MUST be threaded through `ChatRequest.model` so the provider's model resolution prefers it over the configured model, without persisting it to settings. The command spawns a Tokio task that drives the provider's `chat()` stream and emits `ai-chat-delta:<session_id>` events with `ChatDelta` payloads, returning `Ok(())` as soon as the task is spawned. An unknown or invalid `provider_id` MUST surface as a `ChatDelta::Error` carrying the validation message.
- `ai_chat_cancel(session_id: String) -> ()` — aborts the in-flight task for that session if any; idempotent if nothing is running.
- `ai_chat_close(session_id: String) -> ()` — aborts in-flight task (if any) and evicts the session from the registry.
- `ai_chat_history(session_id: String) -> Vec<ChatTurn>` — returns the current persisted turns; used by the frontend on tab remount in the future, no-op in v1.

The previously registered `ai_generate_sql` command from `add-ai-providers` MAY remain registered as a thin wrapper around `chat()` that collects text-only deltas into a single string; it has no frontend caller after this change and may be marked `#[deprecated]` for a follow-up cleanup.

#### Scenario: ai_chat_send spawns a task and emits events

- **WHEN** the frontend calls `ai_chat_send("abc", "hi", None, None, None)`
- **THEN** the call returns `Ok(())` promptly
- **AND** the frontend's listener on `ai-chat-delta:abc` receives one or more `ChatDelta` events followed by `Done`

#### Scenario: Explicit provider override is honored without touching settings

- **WHEN** the frontend calls `ai_chat_send("abc", "hi", Some(conn), Some("anthropic-api"), Some("claude-sonnet-4-6"))`
- **THEN** the turn is answered by `anthropic-api` using model `claude-sonnet-4-6`
- **AND** `ai_settings` and `ai_connection_overrides` remain unchanged

#### Scenario: Invalid provider override surfaces an error

- **WHEN** the frontend calls `ai_chat_send("abc", "hi", Some(conn), Some("not-a-provider"), None)`
- **THEN** a `ChatDelta::Error` is emitted on `ai-chat-delta:abc` describing the invalid provider
- **AND** the session's existing binding is left unchanged

#### Scenario: ai_chat_cancel kills CLI process

- **GIVEN** a `claude-cli` chat is mid-stream with a running child process
- **WHEN** `ai_chat_cancel(session_id)` is invoked
- **THEN** the task is aborted
- **AND** the child process is killed within 100ms (verified by absence in process list)
- **AND** a final `ChatDelta::Error("cancelled")` event is emitted before the channel closes
