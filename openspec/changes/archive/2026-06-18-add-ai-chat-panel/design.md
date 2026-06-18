## Context

`add-ai-providers` shipped four providers behind a single-turn modal. The trait's `generate_sql()` already returns a stream — designed exactly for this moment — but the frontend collapses it into a string and the UI shows nothing of the model's reasoning or file access. CLI providers (`claude-cli`, `codex-cli`) are agents: when pointed at a context folder they read files, plan, write, sometimes self-correct. Hiding that loop behind a modal kills the very signal users were buying when they chose a CLI over an API.

The pre-existing patterns we lean on:
- **Tauri event emission** for streaming. `modules/context/registry.rs` (the `TauriEmitter` pattern) shows the canonical way to push events from Rust to a specific window.
- **Per-tab React state** in `QueryTab.tsx` (tab-local chat state mirrors how query history is per-tab).
- **CodeMirror handle** (`QueryEditorHandle.replaceBody`, `setCursor`) for direct buffer manipulation.
- **Split-pane layout** exists already in the schema browser sidebar — same split primitive can be reused or extended for the right-docked chat.
- **Radix Dialog vs docked panel** — the dock is not a dialog. Use a styled `<aside>` with its own width state, not Radix Dialog (which is for modals).
- **CLI output formats**: Claude Code documents `--output-format stream-json` and `--resume <session-id>` for multi-turn. Codex CLI's structured output story is less clear and will be a spike.

## Goals / Non-Goals

**Goals:**
- Multi-turn chat conversation, fully in-memory, scoped to the query tab.
- Real-time streaming render of `Text`, tool calls, and status from CLI providers.
- API providers participate in chat as text-only streams (no tool-use protocol yet) by sending full message history per turn.
- CLI providers preserve `current_dir = connection.context_path` across every turn.
- Code blocks in AI responses get per-block **Apply** actions (Insert at cursor, Replace buffer) wired directly to the CodeMirror handle.
- Optional Auto-apply toggle (persisted per app, defaults off).
- The "✨" button in the editor toolbar toggles the panel rather than opening a modal. The modal is removed.
- Cancel an in-flight turn cleanly (kill child process for CLIs; abort fetch for APIs).
- Chat panel collapse/restore with width persisted to localStorage.

**Non-Goals:**
- Cross-session / cross-tab chat persistence (deferred — chat history is in-memory and dies with the tab).
- Tool-use protocol for API providers (still deferred — APIs are text-only).
- Replication of the chat panel into MySQL/MSSQL/Dynamo/CloudWatch editors (mechanical follow-up after Postgres proves the shape).
- Token / cost accounting (still deferred).
- Streaming server-sent events (SSE) from API providers — we keep one-shot HTTP per turn in v1, then wrap the single response in a streamed delta. Real SSE wiring is a follow-up.
- Chat-driven actions outside SQL editing (no `EXPLAIN`, no schema graph mutation, no anything-but-SQL).
- Provider switching mid-conversation. The provider resolved at session start is used for the whole chat.

## Decisions

### Decision 1: Tauri events for streaming, not stream-returning commands

```rust
#[tauri::command]
pub async fn ai_chat_send(
    session_id: String,
    prompt: String,
    connection_id: Option<String>,
    db: State<'_, DbState>,
    app: AppHandle,
) -> AppResult<()> {
    // Resolve provider, spawn task, emit events on channel `ai-chat-delta:<session_id>`.
    // Returns Ok(()) as soon as the task is spawned; the actual data flows via events.
}
```

The Tauri IPC layer can't natively return a stream to JS. Returning a string (as `ai_generate_sql` does) collapses the stream. The cleanest pattern is to spawn a Tokio task in the command that emits typed events via `app.emit_to(window_label, channel, payload)`. The frontend subscribes via `listen<ChatDelta>("ai-chat-delta:<session_id>", ...)`.

**Why:** matches the existing `ai-settings-changed` event pattern (already used in `add-ai-providers`). Doesn't require new Tauri APIs. Channel naming includes the session id so multiple tabs don't see each other's traffic.

**Alternatives considered:**
- *Tauri channels (`Channel<T>` introduced in Tauri 2)*: cleaner but newer and we've not used it elsewhere yet. Worth migrating to once we've shipped one consumer with events; not v1.
- *Returning a stream wrapped in a polling command (`ai_chat_poll(session_id)`)*: more roundtrips, worse latency, harder to reason about cancellation.

### Decision 2: `ChatDelta` enum is the wire format

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "PascalCase")]
pub enum ChatDelta {
    Text(String),
    ToolCallStarted { id: String, name: String, input: serde_json::Value },
    ToolCallFinished { id: String, output: String, is_error: bool },
    Status(String),                       // free-form provider status messages
    Done { finish_reason: Option<String> },
    Error(String),
}
```

The frontend renders each variant differently:
- `Text` appends to the current assistant message bubble.
- `ToolCallStarted` opens a collapsible "tool call" card under the message (mirrors Conductor's behaviour).
- `ToolCallFinished` closes the matching card with the result (truncated, expandable).
- `Status` renders as a faint inline annotation ("reading manifest.json…").
- `Done` finalises the assistant message and re-enables the prompt input.
- `Error` finalises with an error state and a Retry action.

**Why:** discriminated union → exhaustive frontend rendering, same serde pattern we use for `ValidationResult` and `GenerateDelta`.

**Alternatives considered:**
- *Reuse `GenerateDelta`*: too narrow — no tool-call variants. Extending it would force every existing consumer to handle new variants. Cleaner to fork.

### Decision 3: Chat history is per-tab, in-memory, kept on the Rust side

A `ChatSessionRegistry` lives in app state, keyed by session id (UUID minted by the frontend per tab). Each session holds:

```rust
struct ChatSession {
    connection_id: Option<Uuid>,
    provider_id: ProviderId,
    context_path: Option<PathBuf>,
    turns: Vec<ChatTurn>,
    in_flight: Option<JoinHandle<()>>,   // for cancellation
}

struct ChatTurn {
    role: Role,                  // User | Assistant
    content: String,
    tool_uses: Vec<ToolUseRecord>,
}
```

When the user sends a turn, the command appends to `turns`, spawns the task, and the task knows how to format `turns` into provider-appropriate input (CLI prompt body or API `messages` array).

**Why:** keeping history on Rust side means the frontend doesn't need to re-send it every turn. Cancellation is one-line (`JoinHandle::abort`). When the tab closes the frontend calls `ai_chat_close(session_id)` to drop the entry; if it forgets, an LRU eviction at ~64 sessions keeps memory bounded.

**Alternatives considered:**
- *Frontend holds history, sends full transcript per turn*: simpler Rust, but every turn re-serialises potentially-large history over IPC. Acceptable for a few turns, painful at 50+.
- *Sqlite-persisted history*: nice to have, but cross-session persistence is an explicit non-goal in v1.

### Decision 4: Provider trait gets `chat()`, `generate_sql()` becomes a thin wrapper

```rust
#[async_trait]
pub trait AiProvider: Send + Sync {
    fn id(&self) -> ProviderId;
    fn capabilities(&self) -> Capabilities;
    async fn validate(&self) -> ValidationResult;
    async fn chat(&self, req: ChatRequest) -> AppResult<ChatStream>;

    /// Convenience wrapper for single-turn SQL generation, retained for legacy
    /// consumers. Default impl calls `chat()` and collects text-only deltas
    /// into a single string. Concrete providers may override for efficiency.
    async fn generate_sql(&self, req: GenerateRequest) -> AppResult<GenerateStream> {
        default_generate_via_chat(self, req).await
    }
}

pub struct ChatRequest {
    pub turns: Vec<ChatTurn>,          // full conversation including the new user turn
    pub context_path: Option<PathBuf>, // CLIs cwd; APIs ignore
    pub context_payload: AiPayload,    // APIs embed in system prompt every turn; CLIs ignore
    pub model: Option<String>,
}

pub type ChatStream = Pin<Box<dyn Stream<Item = AppResult<ChatDelta>> + Send>>;
```

**Why:** `chat()` is the richer primitive; `generate_sql()` collapses it. Default impl saves boilerplate for the API providers (which don't tool-use yet). CLI providers override `chat()` because they have richer event sources (`--output-format stream-json` for Claude).

**Alternatives considered:**
- *Drop `generate_sql` entirely*: tempting but breaks the existing `ai_generate_sql` command and its tests. Keeping the wrapper costs nothing.
- *Two traits*: same anti-pattern we rejected in Decision 1 of `add-ai-providers`. Capabilities, not separate traits.

### Decision 5: CLI integration — `claude-cli` uses `--output-format stream-json --resume`

```rust
// Spawn:
//   claude -p --output-format stream-json [--resume <session-id>] --model <m> <prompt>
//
// stdout contains one JSON object per line, each one a ClaudeStreamEvent:
//   { "type": "message_start", ... }
//   { "type": "tool_use", "name": "read_file", "input": { ... }, "id": "..." }
//   { "type": "tool_result", "tool_use_id": "...", "content": "..." }
//   { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "..." } }
//   { "type": "message_stop", "stop_reason": "end_turn" }
```

The provider parses each line and maps to `ChatDelta`. `--resume` is keyed on a session-id the CLI stores in its own state directory; we capture the id from the first turn's output and reuse it on subsequent turns to preserve conversation state on the CLI side. If `--resume` fails (CLI doesn't have the session anymore) we fall back to sending the full prior conversation as the prompt body.

For `codex-cli`: the structured output format is unverified (see proposal open questions). For v1, we run `codex exec <prompt-with-history>` and stream stdout as raw `Text` deltas + a single `Status("running codex…")` annotation. Tool-call events are deferred until the CLI's structured output stabilises — captured in a follow-up.

**Why:** Claude Code's stream-json mode is documented and stable; mapping is direct. Codex falls back to plain text so users can still chat; we acknowledge the asymmetry in the UI ("This provider doesn't expose tool calls yet — see the raw output below.").

**Risks:**
- Claude's stream-json schema can evolve. Pin the version we tested against in a top-of-file comment; failures map to `ChatDelta::Status("unexpected event format")` rather than crashing.
- `--resume` is best-effort. The fallback (re-send history in prompt) is always correct.

### Decision 6: API providers send full message history per turn

```rust
// anthropic body
{
    "model": "...",
    "max_tokens": 4096,
    "system": format!("…context payload embedded as JSON…"),
    "messages": [
        { "role": "user", "content": "first prompt" },
        { "role": "assistant", "content": "first reply" },
        { "role": "user", "content": "follow-up prompt" }
    ]
}
```

For OpenAI: same shape, system message slotted into the messages array as `{ "role": "system", "content": ... }`.

The provider trims the oldest turns when total token count (estimated as `prompt_length / 4`) would exceed 80% of the model's context window. A `ChatDelta::Status("trimmed N old turns to fit context window")` is emitted when this happens.

**Why:** stateless HTTP is the simplest correct option. Token-count heuristic is good enough for v1 (real tokenisation per provider is a follow-up).

**Risks:**
- Crude tokenisation undercounts in some scripts. Worst case the API returns a context-window error; we surface it as `ChatDelta::Error` cleanly.

### Decision 7: Frontend session lifecycle

```typescript
// src/modules/ai/session.ts
class ChatSession {
    sessionId: string;
    connectionId: string;
    contextPath: string | null;
    turns: ChatTurn[];
    state: "idle" | "streaming" | "error";
    listeners: Set<() => void>;

    send(prompt: string): void;
    cancel(): void;
    close(): void;
}
```

Each `QueryTab` owns a `ChatSession` instance. When the tab unmounts the session calls `ai_chat_close(session_id)` to evict from Rust state. Re-opening the same tab mints a new session (no persistence in v1).

A `useChatSession(connectionId)` hook in `src/modules/ai/store.tsx` wires the session to React via the listener set + `useSyncExternalStore`.

**Why:** `useSyncExternalStore` avoids the React-state churn of streaming text. Each delta updates the session's internal `turns` array and notifies listeners; React reads the snapshot.

**Alternatives considered:**
- *useState + setState for every delta*: re-renders on every character, gets laggy past a few hundred chars.
- *Zustand/Jotai store*: project doesn't use them; adding a state library for one feature is overkill.

### Decision 8: Apply actions on code blocks

The chat renderer detects fenced ` ```sql ` blocks in the assistant's text and renders them with three buttons: **Apply** (replace buffer), **Insert** (at cursor), **Copy**. The Apply path calls `editorHandle.replaceBody(sql)`; Insert calls `editorHandle.setCursor + insert`.

An "Auto-apply final SQL" toggle in the panel header, persisted to `localStorage.argus.ai.autoApply`, applies the last SQL block of the last assistant turn automatically when the turn finishes. Off by default.

**Why:** explicit Apply is safer (the user always sees what the AI wrote before it lands in the buffer). Auto-apply is a power-user shortcut for tight iteration loops.

**Alternatives considered:**
- *Inline diff-style preview before Apply*: nicer but Monaco-style diff isn't in our CodeMirror setup. Punt to a follow-up if users ask.

### Decision 9: Panel layout — flex split, persisted width

```
┌───────────────────────────────────────────────────────────┐
│ ▶ Run  💾 Save  ✨                          ─── tabs ──── │
├──────────────────────────────────┬────────────────────────┤
│                                  │ ✨ AI chat          [x]│
│  SELECT … (CodeMirror editor)    ├────────────────────────┤
│                                  │ [user] top customers…  │
│                                  │ [tool] read manifest…  │
│                                  │ [ai] SELECT u.email …  │
│                                  │   [Apply] [Insert] [⎘] │
│                                  │ ─────                  │
│                                  │ [textarea]      Send → │
├──────────────────────────────────┴────────────────────────┤
│  results grid …                                            │
└───────────────────────────────────────────────────────────┘
```

The split uses CSS `display: flex` on the existing editor row container. Panel width: default 360px, draggable resize via a vertical splitter, persisted to `localStorage.argus.ai.panelWidth`. Closed state hides the panel entirely; the ✨ button reopens it.

**Why:** matches the existing layout primitives in the app. No new dependencies.

### Decision 10: Remove the modal, keep no fallback

The modal was shipped briefly in `add-ai-providers`; no users are depending on it yet. We delete `GenerateModal.tsx`, its CSS, and its tests. The "✨" button in `QueryTab.tsx` toggles `panelOpen` state. The `ai-sql-generation` spec is rewritten to describe the chat panel; the modal scenarios are removed.

**Why:** carrying two SQL-generation UIs forever is worse than the brief disruption of removing one before it gains adoption.

## Risks / Trade-offs

- **[CLI stream-json event schema drift]** → Pin the tested version in a comment; emit `ChatDelta::Status` for unknown event types instead of crashing; cover with unit tests over recorded fixtures.
- **[Codex CLI lacks structured output]** → Plain-text fallback is honest: users see raw stdout. Documented in the panel UI ("This provider doesn't emit tool-call events yet.").
- **[API providers can't show tool calls]** → Same UI affordance — a static "API mode: text only" hint. When tool-use ships in a separate change, the same `ChatDelta` types light up.
- **[Long chat history exceeds API context window]** → Conservative truncation with explicit `Status` event so the user knows what was dropped.
- **[CLI process leak on tab close]** → `JoinHandle::abort` plus `kill_on_drop(true)` on `tokio::process::Command` covers all paths. Tested by spinning up a sleep-1000 CLI and killing the session.
- **[Multiple chats running concurrently in different tabs]** → Each session has its own task and event channel; no shared mutable state beyond the registry's `HashMap`, which is guarded by a tokio `Mutex`.
- **[Apply overwrites user's in-progress edits]** → Apply requires an explicit click (Auto-apply opt-in is off by default). When the editor has uncommitted changes since the AI's SQL was generated, the Apply button surfaces a tiny "Editor changed since this answer — Apply anyway?" inline confirmation.

## Migration Plan

1. Land this change behind no flag (the modal had no adoption to protect).
2. The migration step is purely a UX swap: the "✨" button stops opening a dialog, starts toggling a panel. Existing keyboard shortcuts (if any) for the modal are removed.
3. The Rust `ai_generate_sql` command remains callable but loses its only frontend caller. Mark it `#[deprecated]` in a follow-up cleanup PR.
4. Rollback: revert the PR. The modal returns; the chat panel disappears. Since chat history is in-memory, no data is lost on rollback.

## Open Questions

- **Auto-apply scope.** Should Auto-apply require the assistant message to contain exactly one SQL block, or auto-apply the last one always? The first is safer; pending user input. Default to "exactly one block" for v1.
- **Should the panel be accessible via keyboard shortcut (e.g., `Cmd-Shift-A` to focus the input)?** Reasonable yes; add to command palette as `"AI: Focus chat panel"`. Confirm during implementation.
- **`claude-cli --resume` session-id storage.** Where does the CLI persist its session? If it's user-level, our session id needs to be globally unique (UUID is fine). Verify during implementation spike.
- **What happens if a user changes the default provider mid-tab-session?** v1 answer: the active chat continues with its bound provider; only new chats use the new default. Add a small inline notice in the panel header to clarify.
