## 1. Derive onboarding state in WelcomeTab

- [x] 1.1 In `src/platform/shell/tabs/welcome.tsx`, consume `useConnections()` and `useAiSettings()` and compute three booleans: `hasConnection` (`items.length > 0`), `aiConfigured` (`settings != null && (settings.default_provider !== null || settings.overrides.length > 0)`), `hasContextFolder` (`items.some((c) => c.context_path != null)`)
- [x] 1.2 Compute `allDone = hasConnection && aiConfigured && hasContextFolder`

## 2. CTAs wired to existing flows

- [x] 2.1 Add-connection CTA → `useKindPicker().open()`
- [x] 2.2 Configure-AI CTA → `CommandRegistry.get("ai.configureProviders")?.run()`
- [x] 2.3 Link-context-folder CTA → resolve the target connection (first in `items`) and call the correct `useXForm().openEdit(connection)` by `connection.kind` (`POSTGRES_KIND` → `usePostgresForm`, `MYSQL_KIND` → `useMysqlForm`, `MSSQL_KIND` → `useMssqlForm`, `DYNAMO_KIND` → `useDynamoForm`); build a small `kind → openEdit` dispatch
- [x] 2.4 Lock the link-context-folder item (no CTA, muted "Add a connection first" hint) while `!hasConnection`

## 3. Checklist UI

- [x] 3.1 Render a "Getting started" checklist with the three items in order (connection, AI provider, context folder), each showing a ✓ (satisfied) / ○ (todo) mark, a label, a one-line hint, and an accent CTA button when unsatisfied and unlocked
- [x] 3.2 When `allDone`, replace the active checklist with an unobtrusive completion state (e.g. "✓ You're all set"); keep the lore and shortcuts sections
- [x] 3.3 Add styles to `src/platform/shell/tabs/welcome.module.css` following `DESIGN.md` (status marks, CTA buttons, spacing; restrained, single-accent, no gradients)

## 4. Reactivity & verification

- [x] 4.1 Verify items recompute reactively when a connection is added/removed, an AI provider is configured, or a context folder is linked (no manual refresh) — relies on the reactive `useConnections`/`useAiSettings` stores
- [x] 4.2 Verify the checklist re-expands when a previously satisfied prerequisite is lost (e.g. last connection removed)

## 5. Tests & docs

- [x] 5.1 Add component tests for `WelcomeTab`: each item reflects satisfied/unsatisfied for representative states; the context-folder item is locked with no CTA when `!hasConnection`; each CTA invokes the right action (kind picker open, `ai.configureProviders` run, `openEdit` for the connection kind); the collapsed "all set" state renders when all three are satisfied
- [ ] 5.2 Manual QA on the home tab across states: fresh (nothing configured), partial (connection only / connection + AI), and complete; confirm reactive flips and auto-collapse
