## Why

The AI chat panel is a one-way street: the user asks, the agent emits SQL, Argus runs it — and the result rows live in the data grid, invisible to the next turn. To drill in ("now show me the orders for the top 3 customers above") the user must copy/paste rows back into the prompt or rephrase from scratch, and the model has to re-derive intermediate facts it produced one turn earlier. Now that #59 has pinned the agent to *emitting* SQL (never executing it), the natural next step is to close the loop by handing the *results* back as context.

## What Changes

- Capture the result of a successfully executed SQL query (column names + rows + truncation marker) in the chat panel's in-memory session state, capped to keep payloads sane (first 100 rows / 50 KB serialised). Larger results are attached as a truncated summary and flagged.
- Add a composer affordance in the chat panel — an "Attach result (N rows)" chip sourced from the live grid result — that includes those rows as context for the next message. Multiple attachments allowed, each removable, persisted only within the current chat session (no disk write).
- Extend the cross-provider wire format with an optional `attached_results` field on `ChatRequest`, with one shape (`AttachedResult`) consumed identically by all four providers.
- **API providers** (`anthropic-api`, `openai-api`): serialise attachments as the trailing section of `build_api_system_prompt`, filling the slot #59 reserved after `# Database context`.
- **CLI providers** (`claude-cli`, `codex-cli`): prepend attachments as a fenced markdown table to the latest user turn at the `#62` insertion points #59 left in `flatten_history_for_cli`.
- Token-budget guard: when serialised attachments would push the request over the existing soft cap, evict the oldest attachment first (a step the existing turn-trimming does not perform) and surface a status delta.
- **BREAKING** (internal API only): `build_api_system_prompt` signature gains an `attachments: &[AttachedResult]` parameter.

## Capabilities

### New Capabilities
- `ai-chat-result-attachments`: capturing executed-query results into chat session state, the attach/remove UI affordances, per-attachment truncation, the cross-provider `AttachedResult` wire shape, and oldest-first budget eviction.

### Modified Capabilities
- `ai-agent-guardrails`: the "API system prompt is assembled in a stable section order" requirement reserved the trailing position "for content appended by later changes"; this change fills that slot with the attachments section and extends the budget-accounting requirement to cover oldest-first attachment eviction.

## Impact

- **Backend** (`src-tauri/src/modules/ai/`): `types.rs` (`AttachedResult`, `ChatRequest.attached_results`, `build_api_system_prompt` signature + trailing section), `claude_cli.rs` / `codex_cli.rs` (markdown-table prepend at the `#62` insertion points), `anthropic_api.rs` / `openai_api.rs` (pass attachments into the builder, oldest-first eviction before composing).
- **Frontend** (`src/`): `postgres/sql/QueryTab.tsx` (pass `runner.state.result` to `ChatPanel`), `ai/components/ChatPanel.tsx` (attach/remove chips on the composer), `ai/session.ts` (carry `attached_results` on `chatSend()`).
- **No** disk persistence, no schema migration, no new DESIGN.md tokens (chips reuse existing accent + radius tokens).
- Out of scope (v1): persisting attachments across restarts; arbitrary CSV/file uploads; agent-initiated result re-fetch (tool-use protocol); CloudWatch Logs results (pending #59-style schema-sync there).
