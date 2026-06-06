## Why

Using AI in the Postgres SQL editor requires two prerequisites — a configured AI
provider and a linked context folder — but neither is discoverable. When no
provider is set, the ✨ button simply does not render (`QueryTab.tsx:631`), so the
feature is invisible and the user has no way to learn it exists or what is
missing. When a provider exists but no context folder is linked, the chat opens
anyway and runs in a degraded mode (empty payload) signalled only by a tooltip.
Users cannot tell, at a glance, whether AI is ready, what is missing, or how to
fix it.

## What Changes

- **Always render the ✨ button** for every Postgres connection, regardless of AI
  configuration state. It becomes the single, always-present entry point.
- **Context folder becomes a blocking prerequisite** (not a degraded mode). The
  AI chat can only be used when *both* a provider and an available context folder
  are configured. **BREAKING**: removes the current behaviour where chat runs with
  an empty/temp-dir payload when no context folder is linked.
- **Setup checklist inside the chat panel**: when prerequisites are unmet,
  clicking ✨ opens the panel in a setup mode showing a two-item checklist —
  AI provider and context folder — each with a direct CTA (open "AI: Configure
  providers" / open the connection form to link a context folder). The chat input
  is hidden/disabled until both are satisfied.
- **Readiness model**: a single derived state — `not-configured`,
  `needs-context`, `ready` — drives the button affordance, the panel mode, and the
  status indicator, eliminating today's duplicated checks in `QueryTab` and
  `ChatPanel`.
- **Status indicator** fused into the ✨ button (a small status dot) communicating
  at a glance whether AI is ready, needs setup, or needs a context folder.
- A linked-but-missing-on-disk context folder is treated the same as no context
  folder (prerequisite unmet).

## Capabilities

### New Capabilities
- `ai-setup-readiness`: Derives and surfaces the AI prerequisite state for a
  connection (provider + context folder), drives the always-visible ✨ entry
  point, the in-panel setup checklist with CTAs, the status indicator, and gates
  chat usage on both prerequisites being met.

### Modified Capabilities
<!-- The ai-chat-panel and ai-providers capabilities are still defined in
     unarchived changes (add-ai-chat-panel, add-ai-providers) and not yet in
     openspec/specs/, so the new behaviour is captured as a new capability rather
     than a delta against a not-yet-archived spec. -->

## Impact

- **Frontend**:
  - `src/modules/postgres/sql/QueryTab.tsx` — remove the `aiConfigured` render
    gate on the ✨ button; always render it; wire the status dot and the
    "link context folder" CTA via `usePostgresForm().openEdit(connection)`.
  - `src/modules/ai/components/ChatPanel.tsx` — add setup-mode rendering
    (checklist), gate `ChatSession` creation on `ready`, gate the input, and
    remove the degraded-mode "no context folder" tooltip/badge messaging.
  - New `src/modules/ai/` hook (e.g. `useAiReadiness`) deriving the three-state
    readiness, reusing `aiSettings` (reactive store) and context availability
    (`contextApi.listObjects` + `useContextChangeListener`, classifier in
    `availability.ts`).
- **Mechanisms reused (no new infra)**: `CommandRegistry` to run
  `ai.configureProviders`; `FormController`/`usePostgresForm` to open the
  connection form where `ContextFolderRow` lives.
- **Scope**: Postgres only — the AI chat panel is currently Postgres-only.
- **Design**: must follow `DESIGN.md` for the checklist empty state, the status
  dot, and CTA styling.
