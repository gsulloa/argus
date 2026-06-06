## Context

The Postgres AI chat panel has two prerequisites that are invisible to the user:

- **Provider**: resolved in `QueryTab.tsx:326-335` as `aiConfigured` (global
  default provider OR a per-connection override). When false, the ✨ button is not
  rendered at all (`QueryTab.tsx:631`), so the feature is undiscoverable.
- **Context folder**: `contextPath` resolved from the connection
  (`QueryTab.tsx:338-339`). When absent, the chat opens anyway and `ChatPanel`
  runs degraded, signalled only by a tooltip (`ChatPanel.tsx:626-631`).

The mechanisms to *complete* each prerequisite already exist and are reusable:

- `CommandRegistry.get("ai.configureProviders")?.run()` opens the AI settings
  modal (`AiSettingsHost.tsx:15-21`).
- `usePostgresForm().openEdit(connection)` (`FormController.tsx`) opens the
  connection form, which hosts `ContextFolderRow` (`ConnectionForm.tsx:468`) with
  its own `none` / `linked` / `missing` states.
- Context availability is already classifiable: `contextApi.listObjects` +
  `isMissingFolderError` (`availability.ts`), and changes are observable via
  `useContextChangeListener` (used by `ContextFolderBanner`).
- AI settings are reactive via the `useAiSettings` store.

The product decision (from exploration) is that **context becomes a blocking
prerequisite**: chat is only usable when both provider and context are present.
This removes today's degraded no-context mode.

## Goals / Non-Goals

**Goals:**

- A single derived readiness state (`not-configured` | `needs-context` | `ready`)
  reused by the button, the panel, and the status indicator.
- The ✨ button is always visible for every Postgres connection.
- Clicking ✨ always opens the panel; the panel shows a setup checklist with CTAs
  until both prerequisites are met, then becomes the chat.
- A status dot on the ✨ button communicates readiness at a glance.
- Reactive transitions: completing a prerequisite flips the panel from setup to
  chat without a manual refresh.

**Non-Goals:**

- Extending AI chat or this UX to MySQL/MSSQL/Dynamo (Postgres-only today).
- Changing the AI provider configuration flow or the context folder linking flow
  themselves — we only add entry points/CTAs to the existing flows.
- Auto-creating or auto-linking context folders.
- CloudWatch context-folder schema sync (out of scope).

## Decisions

### Decision 1: A single `useAiReadiness(connectionId)` hook in `src/modules/ai/`

Derive readiness in one place and consume it from `QueryTab` (button + dot) and
`ChatPanel` (mode + gating). It composes:

- provider configured? — from `useAiSettings` (default provider or per-connection
  override), the same logic currently inlined as `aiConfigured`.
- context availability — `none` (no `context_path`) | `available` | `missing`,
  reusing the `contextApi.listObjects` + `isMissingFolderError` pattern already in
  `ContextFolderBanner`, and subscribing via `useContextChangeListener` for
  reactivity.

Mapping: no provider → `not-configured`; provider but context `none`/`missing` →
`needs-context`; provider + context `available` → `ready`.

**Why over the status quo**: today `QueryTab` computes `aiConfigured`/`contextPath`
and `ChatPanel` *independently* re-checks availability — duplicated and drift-prone.
A shared hook removes the duplication and guarantees the button dot and the panel
mode agree.

**Alternative considered**: keep checks inline and pass booleans down. Rejected —
perpetuates duplication and makes the three-state indicator awkward.

### Decision 2: `ChatPanel` has two modes; session lifecycle gated on `ready`

`ChatPanel` renders a **setup checklist** when readiness is not `ready`, and the
existing chat interface when `ready`. The `ChatSession` is only minted when
`ready` (move the gate in `ChatPanel.tsx:482-491` from `open` to `open && ready`).

**Why**: creating a session without a provider/context is meaningless and could
error. Gating on `ready` keeps setup mode inert and makes the setup→chat
transition a natural re-render when readiness flips.

**Alternative considered**: a separate popover from the button for setup, leaving
`ChatPanel` chat-only. Rejected — a new surface to build/style; the docked panel
already has the `emptyState` slot and gives room for the checklist + explanations.

### Decision 3: Status indicator fused into the ✨ button (status dot)

Render a small status dot on the ✨ button rather than a separate toolbar badge:
one affordance, minimal toolbar clutter, consistent with `DESIGN.md`'s restraint.
The dot distinguishes `ready` from the unmet states.

**Alternative considered**: a separate text badge ("Setup" / "Ready") next to the
button. Rejected as noisier; can revisit if the dot proves too subtle.

### Decision 4: CTAs reuse existing flows, no new infra

- Provider CTA → `CommandRegistry.get("ai.configureProviders")?.run()`.
- Context CTA → `usePostgresForm().openEdit(connection)` (QueryTab is inside the
  postgres module, so the form controller is in scope). The connection form's
  `ContextFolderRow` already handles `none` vs `missing` ("Create / Link" vs
  "Locate"), so the CTA simply opens the form and lets that component drive.

### Decision 5: `missing` context folder treated as `needs-context`

A linked-but-missing-on-disk folder is functionally unusable, so it maps to
`needs-context` (per the product decision). The checklist's context CTA still
opens the connection form, where the `missing` state surfaces a "Locate…" action.

### Decision 6: Remove degraded-mode messaging

Remove the no-context tooltip/badge copy in `ChatPanel.tsx:626-631` describing
empty-payload/temp-dir behaviour, since that path no longer exists. When `ready`,
the context badge still shows the linked folder name as today.

## Risks / Trade-offs

- **[Always-visible button adds UI for non-AI users]** → Accepted per product
  decision (discoverability priority); the status dot keeps it unobtrusive and it
  never blocks the editor.
- **[Behaviour change: no-context chat removed]** → BREAKING for anyone relying on
  degraded chat. Mitigation: the setup checklist makes the requirement explicit
  and one click from resolution; documented as a breaking change in the proposal.
- **[Readiness flicker on first render]** while context availability is being
  fetched (`unknown` state) → Treat `unknown` as not-`ready` (show checklist or a
  neutral/loading dot) to avoid briefly enabling chat, then settle when the check
  resolves.
- **[Reactivity gaps]** if the provider modal or connection form complete in a way
  not observed by the hook → provider via reactive `useAiSettings`; context via
  `useContextChangeListener` + connection registry updates. Verify both close the
  loop so the panel transitions without a manual refresh.
- **[Session teardown on transition]** when readiness drops from `ready` to not-
  ready mid-session (e.g. context unlinked) → ensure the existing session is
  closed and the panel returns to setup mode cleanly.

## Migration Plan

Frontend-only, no data migration. Ship behind no flag; the change is additive to
the UI plus the one behavioural removal (degraded chat). Rollback is reverting the
frontend changes. Update `README.md`'s AI providers section to reflect that a
context folder is now required to chat.

## Open Questions

- Exact visual treatment of the status dot (color tokens, size, position) —
  resolve against `DESIGN.md` during implementation.
- Should the checklist offer a tertiary "Learn more" link to the README AI
  section, or keep it to the two CTAs? (Leaning: two CTAs only for now.)
