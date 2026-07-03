## 1. Backend — request contract & command

- [x] 1.1 Extend `ai_chat_send` (`modules/ai/commands.rs`) signature with `provider_id: Option<String>` and `model: Option<String>` params.
- [x] 1.2 Parse `provider_id` into `ProviderId` via existing kebab-case serde; on unknown/invalid value, emit a `ChatDelta::Error` with the validation message and leave the session binding unchanged.
- [x] 1.3 Implement resolution precedence: (1) explicit `provider_id` → bind/rebind session; (2) session's already-bound provider; (3) `AiSettings::resolve(...)` for a brand-new session.
- [x] 1.4 Thread the explicit `model` through `ChatRequest.model` so the provider's `resolve_model` prefers it over the configured model; do NOT write it to `ai_settings`/`ai_connection_overrides`.
- [x] 1.5 Update the registered command in the Tauri `invoke_handler` (and any command-list/tests) to match the new signature. (No handler change needed — Tauri's `generate_handler!` reads the function signature; optional params are exposed automatically.)

## 2. Backend — session registry rebind semantics

- [x] 2.1 In `ChatSessionRegistry.open_or_get` (or a new `rebind` path), allow the bound `ProviderId` to change when an explicit override differs from the current binding. (Added `ChatSessionRegistry::rebind`.)
- [x] 2.2 On rebind, clear the session's `provider_state` (resume_id, codex_warning_shown, etc.); preserve `turns`.
- [x] 2.3 Confirm `factory::build(&db, provider_id)` still keys on `ProviderId` only and picks up the new provider; verify API providers reconstruct context from full `turns`. (Confirmed — no change needed.)

## 3. Frontend — API & session state

- [x] 3.1 Update `aiApi.chatSend()` (`src/modules/ai/api.ts`) to pass `provider_id` and `model` to `ai_chat_send`.
- [x] 3.2 Add session-scoped `providerId`/`model` state to `ChatSession` (`src/modules/ai/session.ts`), initialized from `useResolvedProviderId(connectionId)` + `getModelForProvider(...)`; send them on each `send()`. (Added `initProvider`/`setProvider`.)
- [x] 3.3 Track an "explicit override" flag on the session so the settings-change notice can be suppressed once the user has taken manual control. (`providerOverridden`.)

## 4. Frontend — selector UI in ChatPanel

- [x] 4.1 Replace the read-only provider/model badge (`ChatPanel.tsx`) with an interactive selector control (provider menu + model sub-choice for the active provider). (Reused Radix `DropdownMenu` with `Sub` for models.)
- [x] 4.2 Populate options from `ai_list_providers`; render `Ready` providers as selectable, `Missing`/`Misconfigured` as disabled with hint + a "Configure…" affordance that opens AI settings / the command-palette entry. (`CommandRegistry.get("ai.configureProviders")`.)
- [x] 4.3 On selection, update session state, keep existing turns rendered, and switch the provider for subsequent turns.
- [x] 4.4 Reconcile with the mid-chat settings-change notice: suppress it once an explicit override exists; keep it otherwise.
- [x] 4.5 Style per `DESIGN.md` — reuse existing menu/badge tokens; no new visual language, no AI-slop.

## 5. Verification & docs

- [ ] 5.1 Manual QA: switch provider mid-conversation (claude-cli → anthropic-api), confirm history preserved and next turn answered by the new provider. (NOT run in the live app — logic verified via backend rebind path + tests + code review; interactive QA still recommended before merge.)
- [x] 5.2 Verify `ai_settings` and `ai_connection_overrides` are unchanged after using the selector (no persistence). (Verified by construction — selector calls only session state + `ai_chat_send`; no settings-mutation command is invoked.)
- [x] 5.3 Verify new chat initializes from per-connection override, else global default. (Verified via `initProvider` effect using `useResolvedProviderId` + `AiSettings::resolve` tests.)
- [x] 5.4 Verify unready provider is disabled with hint and routes to settings; invalid provider_id surfaces a `ChatDelta::Error`. (Verified via code review of the selector's disabled branch and the `ai_chat_send` invalid-provider error path.)
- [x] 5.5 Update `README.md` "AI providers" with a note on the per-conversation selector.
- [x] 5.6 Run backend (`cargo`) + frontend build/lint; add/adjust tests around the new `ai_chat_send` params and rebind behavior where feasible. (`cargo check` clean; `cargo test modules::ai` 155 passed; frontend `tsc --noEmit` clean; `eslint` 0 errors; `vitest ChatPanel` 42 passed.)
