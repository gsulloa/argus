## 1. Backend types and trait extension

- [x] 1.1 In `src-tauri/src/modules/ai/types.rs` add `ChatRole` (`User | Assistant`), `ToolUseRecord { id, name, input, output, is_error }`, `ChatTurn { role, content, tool_uses }`, `ChatRequest { turns, context_path, context_payload, model, session_id }`, `ChatDelta` discriminated enum (`Text | ToolCallStarted | ToolCallFinished | Status | Done | Error`), and `ChatStream` type alias `Pin<Box<dyn Stream<Item = AppResult<ChatDelta>> + Send>>`. Add unit tests for `ChatDelta` round-tripping through JSON with the `kind`-tag PascalCase pattern.
- [x] 1.2 In `src-tauri/src/modules/ai/provider.rs` add `async fn chat(&self, req: ChatRequest) -> AppResult<ChatStream>` to the `AiProvider` trait. Provide a `default_generate_via_chat()` helper in `provider.rs` that collects text-only deltas to a `String` so the existing `generate_sql` default impl compiles without each provider re-implementing it.
- [x] 1.3 Convert the existing `generate_sql` method to a default trait method that calls `chat()` and collects via the helper. Concrete providers keep their `generate_sql` overrides only if the override is meaningfully different — otherwise delete the per-provider impl. Confirm `cargo test ai::` still green.

## 2. Chat session registry

- [x] 2.1 Create `src-tauri/src/modules/ai/chat_session.rs` defining `ChatSession { connection_id, provider_id, context_path, turns, in_flight: Option<JoinHandle<()>> }` and `ChatSessionRegistry` (`Mutex<HashMap<String, ChatSession>>` with LRU tracking — a simple `VecDeque<String>` of session ids in access order is enough at MAX_SESSIONS = 64).
- [x] 2.2 Methods: `open_or_get(&self, id, ProviderId, conn_id, ctx_path) -> &mut ChatSession`, `append_user(&self, id, content)`, `append_assistant(&self, id, content, tool_uses)`, `set_in_flight(&self, id, handle)`, `abort(&self, id)`, `close(&self, id)`, `evict_lru_if_needed(&self)`. Cover with unit tests that exercise eviction and abort.
- [x] 2.3 Register `pub mod chat_session;` in `modules/ai/mod.rs`. Add `app.manage(ChatSessionRegistry::new())` in `lib.rs` setup.

## 3. CLI provider — claude-cli structured streaming

- [x] 3.1 In `src-tauri/src/modules/ai/claude_cli.rs` implement `chat()`. Spawn `claude -p --output-format stream-json --model <m> --resume <session_id> <prompt-with-history>`. Pass `kill_on_drop(true)`. Parse stdout line-by-line — each line is a JSON object. Map per the table in `specs/ai-providers/spec.md`. Lines that fail JSON parse emit `Status(...)`. Document the pinned stream-json schema version in a top-of-file comment.
- [x] 3.2 Handle `--resume` failure (CLI doesn't know the session id): fall back to spawning without `--resume` and including prior turns flattened into the prompt body. Detect via the CLI's stderr or an early non-zero exit; emit `Status("session-resume unavailable, replaying history")` and retry once.
- [x] 3.3 Write unit tests that feed canned stream-json fixtures (one file per scenario in `src-tauri/tests/fixtures/claude_stream_json/`) into the parser and assert the resulting `ChatDelta` sequence. Cover at minimum: text-only response, tool-call sequence, message_stop with `end_turn`, unknown event type, malformed JSON line.

## 4. CLI provider — codex-cli plain text fallback

- [x] 4.1 In `src-tauri/src/modules/ai/codex_cli.rs` implement `chat()` by spawning `codex exec -m <m> <prompt-with-history>` (history flattened) and streaming stdout line-by-line as `ChatDelta::Text(line)`. Emit one `Status` event on the first turn explaining the structured-output limitation; do NOT emit it on subsequent turns of the same session (track via `session_id` -> bool map in a thread-safe cell scoped to the provider instance — provider is rebuilt per call, so track in `ChatSessionRegistry` instead with a `codex_warning_shown: bool` per session).
- [x] 4.2 Spike during implementation: run `codex --help` and `codex exec --help` locally to confirm flag stability. Document discovered invocation as a top-of-file comment.
- [x] 4.3 Tests: codex stream yields `Text` deltas for each stdout line; first-turn `Status` is emitted; subsequent turns don't repeat the warning.

## 5. API providers — multi-turn message arrays

- [x] 5.1 In `src-tauri/src/modules/ai/anthropic_api.rs` implement `chat()`. Build `messages` array from `req.turns` (1:1, User/Assistant); embed context payload in `system` exactly as the v1 `generate_sql` does. Issue a single HTTP POST per turn (no SSE yet); on response, parse the assistant text, extract the first fenced block via `extract_fenced_block`, emit a single `Text(extracted)` + `Done`.
- [x] 5.2 In `openai_api.rs` mirror the same with the `/v1/chat/completions` shape — system prompt becomes a leading `{ "role": "system", "content": "..." }` entry, `Authorization: Bearer <key>` header.
- [x] 5.3 Implement context-window trimming: estimate tokens as `total_chars / 4`, look up the model's window from a static table in `caps.rs` (Claude 4.x → 200k, GPT-4o → 128k, etc.), trim oldest non-system turns until estimate ≤ 80%. Emit `Status("trimmed N old turns…")` when N > 0. Tests: feed 200 fake long turns and verify trimming behaviour.
- [x] 5.4 wiremock tests for each API provider: multi-turn body includes all turns; 401 yields `Misconfigured` via existing validate path; success emits Text + Done; no tool-call deltas ever emitted; unsupported model rejected before HTTP.

## 6. Tauri commands

- [x] 6.1 Create `ai_chat_send(session_id, prompt, connection_id, ...)` in `commands.rs`. Logic: resolve provider on first call via `AiSettings::resolve`; bind it to the session; append User turn; spawn a Tokio task that drives the provider stream and emits events to channel `ai-chat-delta:<session_id>` via `app.emit_to(window, channel, payload)`; store the `JoinHandle` on the session; return `Ok(())`.
- [x] 6.2 `ai_chat_cancel(session_id)` — calls `registry.abort(session_id)` then emits a final `ChatDelta::Error("cancelled")` event on the channel so the frontend can finalise its UI.
- [x] 6.3 `ai_chat_close(session_id)` — calls `registry.close(session_id)`.
- [x] 6.4 `ai_chat_history(session_id) -> Vec<ChatTurn>` — read-only view of the persisted turns. Returns empty if session unknown.
- [x] 6.5 Register all four commands in `lib.rs` `invoke_handler!`. Mark `ai_generate_sql` `#[deprecated]` in a comment for follow-up.

## 7. Frontend types and api wrappers

- [x] 7.1 In `src/modules/ai/types.ts` add: `ChatRole`, `ChatTurn`, `ChatDelta` discriminated union, `ToolUseRecord`. Match the snake_case shape decision documented in `add-ai-providers` Phase 5. `ChatDelta.kind` is PascalCase (matches the Rust `#[serde(tag = "kind", rename_all = "PascalCase")]`).
- [x] 7.2 In `src/modules/ai/api.ts` add wrappers `chatSend(args)`, `chatCancel(sessionId)`, `chatClose(sessionId)`, `chatHistory(sessionId)`. Each maps to the corresponding Tauri command.

## 8. Frontend chat session manager

- [x] 8.1 Create `src/modules/ai/session.ts` defining `ChatSession`:
  - Constructor mints a session id (`crypto.randomUUID()`).
  - `turns: ChatTurn[]` mutable in-place; subscribers notified via a `Set<() => void>` listener pattern (`useSyncExternalStore` compatible).
  - `send(prompt: string)`: appends a User turn; appends an empty Assistant turn placeholder; subscribes to `ai-chat-delta:<sessionId>` via `listen()`; routes deltas to the placeholder; resolves on `Done` or `Error`.
  - `cancel()`: calls `api.chatCancel(sessionId)`.
  - `close()`: unsubscribes, calls `api.chatClose(sessionId)`.
- [x] 8.2 Buffer `Text` deltas with a small `requestAnimationFrame` debounce to avoid React thrashing when CLIs emit many small text events.
- [x] 8.3 Unit tests with a fake event emitter: `send` appends turns; `Done` finalises; `Error` finalises with error state; `cancel` emits a cancel and finalises locally.

## 9. ChatPanel component

- [x] 9.1 Create `src/modules/ai/components/ChatPanel.tsx` + `ChatPanel.module.css`. Props: `{ connectionId, contextPath, editorRef, open, onOpenChange }`. Renders panel chrome (header with provider badge, model name, context-folder badge, Auto-apply toggle, Stop button when streaming, close button), message list, input area.
- [x] 9.2 Render `ChatTurn`s: User turns as right-aligned bubbles; Assistant turns as left-aligned bubbles. Within Assistant turns, render text with a markdown parser that extracts fenced code blocks into a dedicated `CodeBlock` sub-component (with Apply / Insert / Copy actions). Render `tool_uses` as collapsible inline cards above the text.
- [x] 9.3 Wire Apply: calls `editorRef.current?.replaceBody(sql.trim())` and sets cursor to end. Insert: gets current cursor, inserts SQL with leading newline if line non-empty.
- [x] 9.4 Auto-apply toggle persisted to `localStorage.argus.ai.autoApply`. On `Done`, if toggle on AND exactly one ` ```sql ` block AND editor not modified since prompt sent, call Apply automatically and mark the block with an "Applied" badge.
- [x] 9.5 "Editor changed since this answer" inline notice when auto-apply is suppressed due to user typing.
- [x] 9.6 Stop button visible while session.state === "streaming". Triggers `session.cancel()`.
- [x] 9.7 Provider-change inline notice: subscribe to `useAiSettings()` and compare against the session's bound provider; render inline notice when they diverge.
- [x] 9.8 RTL tests: panel opens with empty state; sending prompt appends User turn and renders Assistant placeholder; mocked deltas render text incrementally; tool-call cards expand/collapse; Apply button calls editor handle; Auto-apply toggle persists; Stop button calls cancel; provider-change notice appears when settings mutated mid-chat.

## 10. QueryTab layout — split with docked panel

- [x] 10.1 In `src/modules/postgres/sql/QueryTab.tsx`: change the editor row container to `display: flex` with the editor on the left (flex: 1) and the chat panel on the right (fixed width from state). Remove the `<GenerateModal>` mount and the modal-open state.
- [x] 10.2 Replace the existing `aiOpen` state with `panelOpen` (default off). Wire the "✨" button to toggle `panelOpen`. Persist `panelOpen` and `panelWidth` to `localStorage.argus.ai.{panelOpen, panelWidth}` keyed by nothing extra (it's app-wide).
- [x] 10.3 Add a vertical splitter element between editor and panel. Drag to resize. Width clamps to [280, 800].
- [x] 10.4 Mount `<ChatPanel connectionId={...} contextPath={...} editorRef={editorRef} open={panelOpen} onOpenChange={setPanelOpen} />` to the right of the editor. The panel manages its own `ChatSession` internally; QueryTab passes the editor handle ref so Apply/Insert work.
- [x] 10.5 When the query tab unmounts, the panel calls `session.close()` so the backend evicts the session.

## 11. Remove the old modal

- [x] 11.1 Delete `src/modules/ai/components/GenerateModal.tsx`, its CSS module, and its test file.
- [x] 11.2 Grep the codebase for any remaining `GenerateModal` references; remove them.
- [x] 11.3 In the frontend's `aiApi`, optionally drop the `generateSql` wrapper if nothing in `src/` calls it (verify with grep). Keep the Rust command for now (we marked it `#[deprecated]` in task 6.5).

## 12. Command palette

- [x] 12.1 Add a new palette entry `id: "ai.focusChatPanel"`, label `"AI: Focus chat panel"`, group `"AI"`. Action: open the panel for the current Postgres tab and focus its input. If not in a Postgres tab, no-op with a toast.
- [x] 12.2 Verify the existing `ai.configureProviders` entry still works unchanged.

## 13. Integration verification (manual)

- [ ] 13.1 Manual smoke: configure `claude-cli`, open Postgres tab with a context folder, open the panel, send "list tables", verify tool-call cards appear, code block renders, Apply replaces buffer, Run still works.
- [ ] 13.2 Manual smoke: same with `anthropic-api` — text streams, no tool cards (expected), code block extracted.
- [ ] 13.3 Manual smoke: multi-turn conversation — send a prompt, get reply, send a follow-up that references earlier ("now order by total spend"), verify the assistant has the context.
- [ ] 13.4 Manual smoke: cancel mid-stream — verify CLI process is killed and panel finalises with "Stopped".
- [ ] 13.5 Manual smoke: change default provider mid-chat — verify bound provider unchanged and inline notice appears.

## 14. Documentation

- [x] 14.1 Update `README.md` "AI providers" section: describe the chat panel (replacing the modal mention). Add a note on the "✨ AI: Focus chat panel" palette entry.
- [x] 14.2 Update `CLAUDE.md` "AI providers (cross-engine)" paragraph: replace any modal mention with chat-panel.
- [x] 14.3 Update `DESIGN.md` only if new tokens or layout primitives were introduced (the panel should reuse existing variables; flag any deviation explicitly). — No changes: ChatPanel.module.css reuses only existing tokens.

## 15. Defer / out-of-scope (explicit)

- [x] 15.1 Cross-session persistence of chat history — separate change.
- [x] 15.2 Tool-use protocol for API providers (so APIs can also emit tool calls) — separate change.
- [x] 15.3 SSE streaming for API providers (real-time text deltas) — separate change.
- [x] 15.4 Chat panel in MySQL / MSSQL / Dynamo / CloudWatch editors — mechanical replication once Postgres is proven.
- [x] 15.5 Inline diff preview before Apply — separate change.
- [x] 15.6 Token / cost accounting in the panel header — separate change.
- [x] 15.7 Provider switching mid-conversation — separate change.
