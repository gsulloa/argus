## Why

The global "Saved Queries" panel currently mixes **two concepts**: the legacy global local-DB saved queries and an **aggregated** view of context-folder queries pulled from every linked connection (`ContextQueriesSection` + `useLinkedContextQueries`). This makes "which folder does a new query go to?" ambiguous (the panel has to prompt with a folder picker) and blurs the mental model. Context queries belong to a specific connection's context folder — they are not global.

We want a clean split: **global saved queries stay global** (the local DB ones, kept as-is), and **everything else is per-connection**, living under each connection's own "Context Queries" branch — which already exists in the sidebar.

## What Changes

- **The global Saved Queries panel shows ONLY local-DB saved queries.** Remove the aggregated context-queries section (`ContextQueriesSection`, `ContextQueryRow`), the `useLinkedContextQueries` usage, the "Choose context folder" target picker, and the context name-prompt from `SavedQueriesPanel`.
- **Remove `New query` from the global panel's `+` menu.** The panel no longer creates queries of any kind; `New folder` (local-DB folder organization) remains. Existing local saved queries stay fully usable (open, run, rename, delete, duplicate, move, search).
- **Context-query creation moves to the per-connection `Context Queries` branch.** Add a `New query` affordance to the branch that authors into that connection's context folder via `context_save_query` and opens it.
- **The `Context Queries` branch gains a setup state.** When the connection has no linked context folder, instead of hiding, the branch renders a compact call-to-action to link or create a context folder for that connection (reusing the connection form's link/create primitives). The branch also renders (with the `New query` affordance) when the folder is linked but empty, so creation is reachable.
- **The SQL editor's save path is unchanged** — first-save still writes to the editor connection's context folder (Name-only modal, per the completed `saved-query-use-connection-context` change).
- The backend `context_list_linked_queries` command is retained for compatibility/tests but is no longer consumed by the UI (the per-connection `context_list_queries` drives the branch).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `saved-queries`: the panel surfaces only local-DB queries (drop the "two sources" model and the aggregated context section); the `+` menu drops `New query`; new-query creation is no longer a panel concern.
- `context-queries-runner`: the per-connection "Context queries sidebar branch" gains a `New query` creation affordance and a no-folder setup CTA, and renders when linked-but-empty; the "Context queries are runnable from the unified Saved Queries panel" requirement is removed (the panel no longer surfaces context queries).

## Impact

- **Frontend only** — no backend/IPC changes:
  - `packages/app/src/modules/saved-queries/SavedQueriesPanel.tsx` — remove `ContextQueriesSection`, `ContextQueryRow`, `useLinkedContextQueries`, target picker + name-prompt dialogs, context routing in `handleCreateQuery`, and the `New query` menu item.
  - `packages/app/src/modules/context/components/ContextQueriesBranch.tsx` (+ its CSS) — add `New query` affordance and header action; render a setup CTA when `contextPath` is null; render when linked-but-empty.
  - `packages/app/src/platform/shell/ConnectionRow.tsx` — the branch is already mounted per active connection (Postgres/MySQL/MSSQL/Dynamo); pass any new handlers/props needed for create.
  - Likely a small shared hook (e.g. `useContextFolderLink(connectionId)`) factored from `context/components/ContextFolderRow.tsx` for the link/create actions used by the branch's setup CTA.
- **Scope**: the `Context Queries` branch is mounted for Postgres, MySQL, MSSQL, and Dynamo today; this change keeps that engine coverage. Athena/CloudWatch branches are out of scope (follow-up).
- **No data migration**; local `saved_query_folders`/`saved_queries` tables and all `context_*` commands are unchanged. `context_list_linked_queries` becomes UI-dead but retained.
- **Supersedes** the (now-removed, unapplied) `saved-queries-context-folder-ux` proposal.
