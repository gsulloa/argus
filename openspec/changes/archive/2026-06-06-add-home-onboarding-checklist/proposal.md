## Why

The Welcome tab (`welcome.tsx`) — the first thing a new user sees — is static lore
and a shortcut list. It never tells the user what to do to get value out of Argus:
add a connection, configure an AI provider, link a context folder. New users have
no guided path, and the three prerequisites are scattered across the sidebar, the
command palette, and the connection form. We just shipped an in-panel setup
checklist for the AI chat (`improve-ai-prerequisites-ux`); this brings the same
discoverable, CTA-driven pattern to the home screen as a first-run onboarding guide.

## What Changes

- **Add a "Getting started" checklist to the Welcome tab** with three items, each
  showing a satisfied/unsatisfied state and a direct call-to-action:
  1. **Add a connection** — satisfied when at least one connection exists; CTA opens
     the connection kind picker (`useKindPicker().open()`).
  2. **Configure AI** — satisfied when an AI provider is configured (global default
     OR any per-connection override); CTA runs `ai.configureProviders`.
  3. **Link a context folder** — satisfied when at least one connection has a linked
     context folder; CTA opens that connection's edit form. This item is **locked**
     (no CTA, explanatory hint) until item 1 is satisfied, since a folder is linked
     to a connection.
- **Reactive state**: the checklist recomputes as the user completes each step
  (reusing the reactive `useConnections` and `useAiSettings` stores) so items flip
  to ✓ without a manual refresh.
- **Auto-collapse when complete**: once all three items are satisfied, the checklist
  collapses to an unobtrusive "You're all set" line (or hides) so returning users
  aren't nagged. The lore and shortcuts remain.
- **Reuse existing flows, no new infra**: kind picker, AI settings command, and the
  per-engine connection `FormController`s already exist; the checklist only adds
  entry points.

## Capabilities

### New Capabilities
- `home-onboarding-checklist`: Derives and surfaces the first-run setup state on the
  Welcome/home tab — a three-item checklist (connection, AI provider, context folder)
  with per-item satisfied/unsatisfied status, direct CTAs into the existing flows,
  dependency locking, reactive updates, and auto-collapse when complete.

### Modified Capabilities
<!-- None. The Welcome tab is not governed by a requirement in app-shell (which
     covers window/layout/tabs/shortcuts), so the home checklist is captured as a
     new capability rather than a delta. -->

## Impact

- **Frontend**:
  - `src/platform/shell/tabs/welcome.tsx` — render the checklist; consume
    `useConnections`, `useAiSettings` (or a small derived helper), `useKindPicker`,
    and the per-engine `FormController` hooks to wire CTAs.
  - `src/platform/shell/tabs/welcome.module.css` — checklist styling per `DESIGN.md`.
- **Mechanisms reused (no new infra)**: `useKindPicker().open()` (add connection);
  `CommandRegistry.get("ai.configureProviders")?.run()` (AI); per-engine
  `useXForm().openEdit(connection)` (context folder, resolved by connection kind).
- **Scope**: home/Welcome tab only. No change to the underlying connection, AI, or
  context-folder flows themselves.
- **Design**: must follow `DESIGN.md` for the checklist (status marks, CTA buttons,
  spacing, the all-set state).
