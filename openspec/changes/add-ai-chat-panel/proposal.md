## Why

The `add-ai-providers` change shipped a single-turn `GenerateModal`: type a prompt, get back one SQL block, click Insert or Replace, modal closes. Real SQL work isn't one-shot — users iterate ("narrow to last quarter", "join `orders` instead", "exclude refunds"), and a modal that closes on first answer forces a copy-paste loop that loses both context and the model's reasoning. Worse, the modal hides exactly what CLI providers do well: when `claude` or `codex` runs against a context folder, it reads files, plans, edits — the steps that make the answer trustworthy. A modal collapses that into one opaque string. Users wanted CLIs because of the agentic loop; the UI should show it.

## What Changes

- **REMOVE** `GenerateModal` and the "✨ Generate" modal-open behaviour in the Postgres SQL editor.
- Add a `ChatPanel` docked to the right of the editor in `QueryTab.tsx`, collapsible, with persistent layout. The "✨" toolbar button now toggles the panel open/closed instead of opening a modal.
- **Multi-turn conversation** in the panel: user prompt → AI response → user iterates. History lives for the lifetime of the query tab (no cross-session persistence in v1).
- **Streaming display**: text deltas, tool-call events (file reads, file edits, status messages), and status badges render incrementally as the provider emits them — same shape Conductor users already see when an agent works.
- **Direct editor manipulation**: the AI can emit a structured "edit" action (replace buffer, insert at cursor) that applies to the CodeMirror editor automatically when the user clicks **Apply** on a code block. An always-on "Auto-apply" toggle is available for users who prefer single-click iteration.
- **Context file access (re-affirmed)**: CLI providers continue to spawn with `current_dir = connection.context_path`. Every turn re-uses the same `current_dir` so the model sees the same folder across the conversation. For `claude-cli`, use `--resume <session-id>` to preserve conversation state in-process where supported; otherwise pass the prior turns as part of the next prompt. For `codex-cli`, pass the conversation history into each `codex exec` call.
- **Backend command shift**: add `ai_chat_send(session_id, prompt) -> ()` that emits Tauri events (`ai-chat-delta:<session_id>`) carrying typed deltas (`Text`, `ToolCallStarted`, `ToolCallFinished`, `Status`, `Done`, `Error`). Keep `ai_generate_sql` as a thin wrapper or deprecate it once the panel is the only consumer.
- **AiProvider trait extension**: add a `chat()` method that returns a richer `ChatStream` (with tool-call deltas). Backwards-compatibility: `generate_sql` becomes a thin convenience wrapper around `chat()` for single-turn cases.
- **API providers (Anthropic, OpenAI)**: support multi-turn by sending the full conversation history each turn. No tool-use protocol yet (still deferred to a separate change) — API providers' chat shows text deltas only, with the database context payload in the system prompt of every turn.
- **CLI tool-call parsing**: `claude-cli` supports `--output-format stream-json` which emits a structured event per tool call. Use that mode and parse the JSON into `ChatDelta::ToolCall*` events. For `codex-cli`, fall back to plain-text streaming if structured output isn't available — surface the raw stdout in a single "process output" event so the user still sees what the CLI is doing.

## Capabilities

### New Capabilities
- `ai-chat-panel`: The docked chat UX — session lifecycle, message list, streaming render, tool-call rendering, code-block Apply action, editor integration, panel collapse/restore.

### Modified Capabilities
- `ai-providers`: `AiProvider` trait gains a `chat()` method returning a richer stream of `ChatDelta` variants (tool calls in addition to text). CLI providers implement structured-event parsing where available. API providers send multi-turn message history. The "stream collected to string" behaviour from v1 remains for the legacy `generate_sql` path but is no longer the primary consumer.
- `ai-sql-generation`: The modal-based generation flow is **REMOVED**. SQL generation now happens through `ai-chat-panel`. The "✨" toolbar button still exists in `postgres-sql-editor`, but it toggles the panel rather than opening a modal. Insert/Replace become per-code-block actions inside chat messages.

## Impact

- **New frontend**: `src/modules/ai/components/ChatPanel.tsx` + CSS module + tests. New `src/modules/ai/session.ts` (chat session manager: send/receive, event subscription, history).
- **Removed frontend**: `src/modules/ai/components/GenerateModal.tsx` and its CSS + tests (or moved to deprecated-only behind a flag if we keep it for non-Postgres consumers — but those don't exist in v1, so straight deletion is cleaner).
- **Frontend store extension**: `useAiSettings` gains nothing new, but a new `useChatSession(connectionId)` hook manages per-tab chat state.
- **New backend command**: `ai_chat_send` (Tauri command). Optional new command `ai_chat_cancel(session_id)` to stop in-flight generation.
- **Backend trait change**: `AiProvider::chat()` added. `generate_sql()` retained as a thin wrapper to keep existing tests compiling, then quietly retired in a follow-up.
- **New backend types**: `ChatDelta` enum (`Text`, `ToolCallStarted { name, input }`, `ToolCallFinished { name, output }`, `Status(String)`, `Done`, `Error(String)`), `ChatSessionId` newtype, `ChatTurn { role, content, tool_uses }` for history.
- **Provider implementations**: `claude_cli.rs` switches to `--output-format stream-json` and parses events. `codex_cli.rs` falls back to plain text in a single `Status`/`Text` stream until structured output is verified. `anthropic_api.rs` and `openai_api.rs` accept a `Vec<ChatTurn>` and serialise it into their respective `messages` arrays.
- **Layout change**: `QueryTab.tsx` gains a horizontal split — editor left, chat panel right (collapsible). CSS variables for panel width persistence (localStorage) so the user's split preference survives reload.
- **DESIGN.md**: no new tokens expected — chat reuses `--surface`, `--surface-2`, `--border`, `--accent`, etc.
- **Migrations**: none — chat is in-memory per tab. Future "persistent chat history" is a separate change.
- **Settings**: no new settings. The AI: Configure providers panel is unchanged.
- **Backward compatibility**: this is a UX replacement, not an additive feature. Anyone who relied on the modal flow loses it. The modal is short-lived in production (`add-ai-providers` is not archived yet), so impact is limited to local testers.

## Open Questions

- Should chat history persist across query-tab close/reopen, or across app restarts? v1 says no — fresh chat per tab. Persistence is a separate change.
- How aggressive should auto-apply be? Off by default — user clicks **Apply** per code block. Toggle persisted to localStorage.
- For API providers with long conversations approaching token limits, what's the fallback? Truncate oldest turns first, with an inline notice. Implementation detail for design.md.
- Should the panel be available outside Postgres in v1? No — same scope discipline as `add-ai-providers` (Postgres first, then mechanically replicate).
