## Why

Today the chat panel's provider/model is resolved once — from the per-connection override or the global default — and the session is locked to it at first send. To try a different engine for one question, the user must open AI settings and change the default (which affects every other chat) or set a per-connection override (a stable preference, not a one-off). There is no lightweight way to say "for *this* conversation, use a different provider" without disturbing the rest of the app.

## What Changes

- Add a **provider/model selector inside the chat panel** (near the header/badge) that shows the conversation's active provider and model and lets the user switch it.
- The selection is **scoped to the current chat session only** — it never writes `default_provider` or `ai_connection_overrides`.
- A new chat still **initializes** its provider from the current resolution (per-connection override if present, else global default). The selector merely overrides that for the session going forward.
- **Switching mid-conversation keeps the existing history** and uses the newly chosen provider for subsequent turns (per the issue's stated preference — no forced new conversation).
- The selector **only offers configured/ready providers**; providers that need setup are shown as disabled/clearly-marked with an affordance to open AI settings to configure them.
- Add an optional `provider_id` override to the chat send path (frontend → `ai_chat_send` → `ChatRequest`), falling back to the current resolution when absent. Reuse `ai_list_providers` to populate and validate the selector.
- **BREAKING (behavioral):** the session provider is no longer immutable for its lifetime — the "bound at first send" model becomes "session-scoped, user-changeable." The existing mid-chat *settings-change* notice must coexist with (and not fight) an explicit user override.

## Capabilities

### New Capabilities
<!-- none — this extends the existing chat panel -->

### Modified Capabilities
- `ai-chat-panel`: The **"Provider/model badge and runtime mismatch handling"** requirement changes — the read-only badge becomes an interactive session-scoped provider/model selector; provider is user-changeable mid-conversation while preserving history; the settings-change notice must reconcile with explicit user overrides.
- `ai-providers`: The chat request contract gains an **optional per-request `provider_id` override** (alongside the already-present `model`), with fallback to the existing settings-based resolution when absent. Session-scoped selection MUST NOT persist to `ai_settings` or `ai_connection_overrides`.

## Impact

- **Backend (Rust):** `ai_chat_send` (`modules/ai/commands.rs`) — accept optional `provider_id`/`model`, use them to bind/rebind the session's provider instead of always calling `AiSettings::resolve`; `ChatSessionRegistry.open_or_get` provider-binding logic; possibly `factory::build` (already takes a `ProviderId`). No new DB tables or migrations.
- **Frontend (TS/React):** `ChatPanel.tsx` (header/selector UI, replaces the read-only badge), `session.ts` (store session-scoped provider/model), `api.ts` (`chatSend` gains provider/model params). Reuse `ai_list_providers` + existing validation.
- **No settings persistence:** `ai_settings` / `ai_connection_overrides` untouched by this flow.
- **Docs/Design:** `README.md` "AI providers" note about the selector; selector styling must follow `DESIGN.md`.
