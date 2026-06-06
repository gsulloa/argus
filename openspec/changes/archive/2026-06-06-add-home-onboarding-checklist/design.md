## Context

The Welcome tab (`src/platform/shell/tabs/welcome.tsx`) is a static component
registered via `TabRegistry`. It currently renders lore + a static shortcut list
and consumes no hooks. It is mounted inside the full provider tree (`App.tsx`:
`ConnectionsProvider`, `AiSettingsProvider`, `ContextEventBusProvider`, the four
`*FormProvider`s, and `KindPickerProvider`), so it can read reactive stores and
trigger existing flows without new plumbing.

The three onboarding prerequisites and their existing entry points:

- **Connection** — `useConnections()` exposes the reactive `items` list. New
  connections are created via `useKindPicker().open()` → engine picker →
  `useXForm().openCreate()`.
- **AI provider** — `useAiSettings()` exposes the reactive `settings`
  (`default_provider`, `overrides`). The settings modal opens via
  `CommandRegistry.get("ai.configureProviders")?.run()` (registered by
  `AiSettingsHost`).
- **Context folder** — a per-connection `context_path` on each `Connection`
  (reactive via `useConnections`). Linking happens inside a connection's edit form
  (`useXForm().openEdit(connection)`), which hosts `ContextFolderRow`.

This mirrors the in-panel setup checklist just shipped in
`improve-ai-prerequisites-ux`; the goal is the same discoverable, CTA-driven
pattern on the home screen.

## Goals / Non-Goals

**Goals:**

- A three-item "Getting started" checklist on the Welcome tab with per-item
  satisfied/unsatisfied status and direct CTAs into existing flows.
- Purely derived, reactive state — no new persistence; items flip as the user
  completes steps.
- Dependency locking: the context-folder item is inert until a connection exists.
- Auto-collapse to an unobtrusive "all set" state when complete.
- Follow `DESIGN.md` and stay visually consistent with the existing Welcome tab and
  the AI setup checklist.

**Non-Goals:**

- Persisting "dismissed"/"skipped" state across launches (the checklist simply
  collapses when prerequisites are met).
- Changing the connection, AI, or context-folder flows themselves.
- A multi-step wizard, progress percentages, or gamification.
- Onboarding surfaces outside the home tab.

## Decisions

### Decision 1: Derive state inline in `WelcomeTab` from existing reactive stores

Compute the three booleans directly in `WelcomeTab`:

- `hasConnection = items.length > 0`
- `aiConfigured = settings != null && (settings.default_provider !== null || settings.overrides.length > 0)`
- `hasContextFolder = items.some((c) => c.context_path != null)`

**Why over a dedicated hook**: unlike `useAiReadiness` (which is shared by
`QueryTab` and `ChatPanel`), this state is consumed in exactly one place. A small
inline derivation avoids over-abstraction. If a second consumer appears later, it
can be promoted to a hook then.

**Alternative considered**: a `useHomeOnboarding()` hook. Rejected as premature for
a single consumer; revisit on reuse.

### Decision 2: Context-folder "satisfied" = `context_path` present (not availability-checked)

We treat the context-folder item as satisfied when any connection has a non-null
`context_path`, without performing a `listObjects` availability probe per
connection. The home checklist is a coarse onboarding nudge, not the precise
gate that the AI panel enforces; probing every connection on the home tab is
unnecessary cost.

**Why**: cheap, fully reactive via `useConnections`, and good enough for "have you
linked a folder yet?". The AI panel already handles the missing-on-disk nuance
where it actually matters.

**Alternative considered**: reuse the `availability.ts` classifier per connection.
Rejected for the home surface (N async probes, marginal benefit).

### Decision 3: Context-folder CTA opens the edit form resolved by connection kind

A context folder is linked to a connection, so the CTA must target one. It opens
the edit form for a chosen connection (the first connection, or the currently
selected one if that is readily available), dispatching to the correct controller
by `connection.kind`:

- `POSTGRES_KIND` → `usePostgresForm().openEdit`
- `MYSQL_KIND` → `useMysqlForm().openEdit`
- `MSSQL_KIND` → `useMssqlForm().openEdit`
- `DYNAMO_KIND` → `useDynamoForm().openEdit`

`WelcomeTab` already lives under all four form providers (same as
`KindPickerProvider`), so all four hooks are in scope. A small `kind → openEdit`
map keeps the dispatch tidy.

**Why**: reuses the exact form (`ContextFolderRow`) that already drives
none/linked/missing states; no new surface.

**Alternative considered**: a bespoke "link folder" dialog on the home tab.
Rejected — duplicates existing form behaviour.

### Decision 4: Dependency locking for the context-folder item

When `!hasConnection`, the context-folder item renders locked: a muted hint
("Add a connection first") and no CTA. This avoids a dead-end CTA (there is no
connection to attach a folder to) and communicates the natural order.

### Decision 5: Auto-collapse when all three are satisfied

When `hasConnection && aiConfigured && hasContextFolder`, replace the active
checklist with a single unobtrusive line (e.g. "✓ You're all set"), keeping the
lore and shortcuts. Because state is derived, removing the last connection (etc.)
naturally re-expands the checklist — satisfying the "reappears if a prerequisite is
lost" scenario for free.

**Alternative considered**: hide entirely when complete. Acceptable too; the
collapsed confirmation is gentler and confirms the state. Final visual treatment to
be settled against `DESIGN.md` during implementation.

### Decision 6: Visual pattern consistent with the AI setup checklist

Reuse the established marks/affordances: `✓` (satisfied, `--success`) / `○`
(todo, `--text-subtle`), a label, a one-line hint, and an accent CTA button for
unsatisfied/unlocked items. Styling lives in `welcome.module.css` following
`DESIGN.md` (restrained, single accent, no decorative gradients).

## Risks / Trade-offs

- **[Adds first-thing-seen UI for power users]** → Mitigated by auto-collapse once
  prerequisites are met; returning users see only the unobtrusive confirmation.
- **[Coarse context-folder check (path present, not available-on-disk)]** → A
  linked-but-missing folder still reads as "satisfied" here. Accepted: the home
  nudge is intentionally coarse; the AI panel enforces real availability.
- **[Which connection the context CTA targets when several exist]** → Pick the
  first (or current) connection deterministically; the user can switch inside the
  form. Low stakes for an onboarding nudge.
- **[Cross-module coupling: home tab imports four form hooks + kind picker]** →
  These already co-exist under the same provider tree; the kind picker itself
  already imports all four form hooks, so the pattern is precedented.

## Migration Plan

Frontend-only, no data migration, no flag. The change is purely additive to the
Welcome tab; rollback is reverting the `welcome.tsx` / `welcome.module.css` edits.

## Open Questions

- Final visual treatment of the completed/collapsed state (single line vs. fully
  hidden) — resolve against `DESIGN.md` during implementation.
- Whether the context-folder CTA should target the first connection or the
  "current"/last-used one — default to first unless a cheap current-selection
  signal is already in scope.
