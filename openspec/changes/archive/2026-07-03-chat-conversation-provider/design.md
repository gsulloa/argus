## Context

Provider resolution today is settings-driven and one-shot. `ai_chat_send` (`modules/ai/commands.rs:414`) calls `AiSettings::resolve(&db, conn_uuid)` (`settings.rs:166`) which returns `{ provider_id, model }` from the per-connection override or the global default. The registry's `open_or_get` binds that `ProviderId` to the session on first send and reuses it for every later turn — the session is provider-immutable. The frontend mirrors this with a `sessionBoundProvider` ref in `ChatPanel.tsx:615` and a read-only badge (`ai-chat-panel` requirement "Provider/model badge and runtime mismatch handling").

`ChatRequest` (`types.rs:106`) already carries an optional `model` (currently unused end-to-end — always `None` from the send path). There is no per-request provider override. `ai_list_providers` (`commands.rs:32`) already returns each provider's `ValidationResult` (`Ready` / `Missing` / `Misconfigured`) and `Capabilities.available_models`, everything the selector needs.

## Goals / Non-Goals

**Goals:**
- Let the user pick the provider (and model) for the *current* conversation from inside the chat panel.
- Keep the choice session-scoped: never touch `ai_settings` or `ai_connection_overrides`.
- Preserve conversation history across a provider switch; subsequent turns use the new provider.
- Only offer ready providers; clearly mark ones needing setup and route to AI settings.
- Initialize a new chat's provider from the existing resolution (override → default).

**Non-Goals:**
- Persisting the session choice anywhere on disk (no new DB columns/migrations).
- Auto-creating separate chats per provider (issue lists this as a possible later step).
- Cross-provider translation of resume/session state — switching provider resets provider-specific `provider_state` (see Decisions).
- Changing how models are validated/sanitized (reuse `caps.rs` / `resolve_model`).

## Decisions

### 1. Session provider becomes mutable; override flows through `ai_chat_send`
Add optional `provider_id: Option<String>` and `model: Option<String>` params to `ai_chat_send`. Resolution precedence per send becomes:
1. Explicit request `provider_id` (from selector) — if present, (re)bind the session to it.
2. Else the session's already-bound provider (unchanged behavior for turns with no override).
3. Else `AiSettings::resolve(...)` for a brand-new session (initial resolution unchanged).

The frontend always sends the session-scoped provider once the user has made (or the panel has initialized) a choice, so step 1 is the normal path; steps 2–3 are fallbacks. `provider_id` maps to `ProviderId` via the existing kebab-case serde; invalid/unknown → `Validation` error surfaced as a `ChatDelta::Error`.

**Alternative considered:** a dedicated `ai_chat_set_provider(session_id, provider_id)` command. Rejected — it adds a round-trip and a state-sync race with the next send; folding the override into the send keeps a single source of truth and matches the issue's "add optional provider_id to the chat request."

### 2. Rebind semantics: keep history, reset provider-specific state
When a send's `provider_id` differs from the session's bound provider, the registry updates the bound `ProviderId` **and clears `provider_state`** (the opaque per-provider map holding `resume_id`, `codex_warning_shown`, etc.). History (`turns`) is untouched and re-sent. Rationale: `resume_id` from claude-cli is meaningless to codex-cli or the API providers; carrying it over would corrupt the new provider's session handling. API providers already send full message history per turn, so they reconstruct context from `turns` regardless.

**Alternative considered:** forbid mid-chat switch (force new conversation). Rejected — the issue's stated preference is to keep history and switch.

### 3. Selector is the interactive form of the existing badge
Replace the read-only provider/model badge in the `ChatPanel` header with a dropdown/menu control. It lists the four providers from `ai_list_providers`; `Ready` ones are selectable, `Missing`/`Misconfigured` ones render disabled with a short hint and a "Configure…" affordance that opens the AI settings / command-palette entry. A nested model choice (from `Capabilities.available_models`) is offered for the active provider. The current selection is stored in `ChatSession` frontend state (`session.ts`), initialized from `useResolvedProviderId(connectionId)` + `getModelForProvider(...)`.

### 4. Reconcile with the existing "settings changed" notice
The mid-chat settings-change notice (`ChatPanel.tsx:788`) compares the bound provider against `currentResolved`. With an explicit user override this comparison is no longer meaningful, so: once the user has explicitly overridden the provider for the session, suppress the settings-change notice for that session (the user has taken manual control). The notice remains for sessions the user never touched.

### 5. No settings persistence — enforced by construction
The selector writes only to frontend session state and the `ai_chat_send` params. It never calls the settings-mutation commands. `factory::build(&db, provider_id)` already reads the model from `ai_settings` at construction; to honor a session model override without persisting, pass the session `model` through `ChatRequest.model` (already exists) so the provider's `resolve_model` picks it over the configured model. `factory::build` stays keyed on `ProviderId` only.

## Risks / Trade-offs

- **Stale `provider_state` after switch** → Cleared on rebind (Decision 2); documented that resume continuity is per-provider and resets on switch.
- **Model override bypasses factory's configured model** → Route the session model via `ChatRequest.model`, which `resolve_model` already validates against `available_models`; retired/invalid models fall back cleanly (`caps.rs` sanitize path).
- **Selector offering a provider that later fails validation** → Selection re-checks against `ai_list_providers`; a provider that goes `Missing` between selection and send surfaces a normal `ChatDelta::Error` with the validation hint (same as today's resolve failure).
- **UI divergence from `DESIGN.md`** → Selector must reuse existing menu/badge tokens; call out in review. No new visual language.
- **Backward compat of `ai_chat_send` signature** → New params are `Option`; older callers (none besides the app) unaffected. Frontend `api.ts` updated in lockstep.

## Migration Plan

Pure additive/behavioral change, no data migration. Deploy backend + frontend together (single app build). Rollback = revert the change; sessions are in-memory only, nothing persisted to migrate back.

## Open Questions

- Should the model sub-selector be shown inline in v1, or provider-only first with model following the provider's default? (Leaning: provider-only switch in the primary menu, model as a secondary control, mirroring settings.) — resolve during implementation/design review.
