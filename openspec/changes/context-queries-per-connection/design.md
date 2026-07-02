## Context

Two components render context queries today:

- **Global panel** — `SavedQueriesPanel.tsx` (mounted in `WorkspaceShell.tsx:291` and `Sidebar.tsx:78`). It renders a local-DB tree (`useSavedQueries`) **and** an aggregated `ContextQueriesSection` (`useLinkedContextQueries` → `context_list_linked_queries`, grouped by `canonical_root:engine`). Its `+` menu has `New query` (routes to a context folder, with a target picker when multiple folders are linked) and `New folder` (local-DB).
- **Per-connection branch** — `ContextQueriesBranch.tsx`, mounted per active connection in `ConnectionRow.tsx` (lines 986–1041, for Postgres/MySQL/MSSQL/Dynamo). It uses `useContextQueries(connectionId, contextPath)` → `context_list_queries` (single connection). It is currently **read-only** and **hidden** when `contextPath` is null or the list is empty.

The connection form's `ContextFolderRow.tsx` already implements the full link/create flow (`handleReuseFolder`, `handleCreateFolder`/`handleCreateFolderWithName`, `handleLinkExisting`) on `contextApi.listKnownFolders`/`createFolder`/`linkFolder` + Tauri `dialogOpen`.

The decision (confirmed with the user): keep global saved queries global (local DB), move all context-query surfacing and creation to the per-connection branch.

## Goals / Non-Goals

**Goals:**
- Global panel = local-DB saved queries only; no context section; no `New query`.
- Per-connection branch = the single home for viewing and creating context queries, plus a setup CTA when unlinked.
- Reuse existing `contextApi` primitives; no backend changes.

**Non-Goals:**
- No change to `context_save_query`, `context_list_queries`, per-engine parameter substitution, or editor-tab open/run behavior.
- No change to the SQL editor's first-save flow (already Name-only → connection's context folder).
- Not deleting `context_list_linked_queries` (retained for compat/tests; just unused by UI).
- Not extending the branch to Athena/CloudWatch (keep current engine coverage: PG/MySQL/MSSQL/Dynamo).
- Existing local-DB saved queries stay; we stop creating new local-DB queries (no new create path), matching "keep the globals as-is."

## Decisions

**Decision: Strip the context section from `SavedQueriesPanel`.**
Remove `ContextQueriesSection`, `ContextQueryRow`, the `useLinkedContextQueries` hook usage, `ctxNewTargets`, the "Choose context folder" picker (`showCtxTargetPicker`), the context name-prompt (`showNewCtxQuery`, `newCtxQueryTargetGroup`), `handleContextQueryCreate/Rename/Delete`, and `pickRepresentativeConnection` if it becomes unused. The `+` menu loses `New query`; `handleCreateQuery` is deleted. The panel reduces to the local-DB tree + `New folder` + search + DnD.
- Alternative considered: keep the aggregated section but make it per-focused-connection. Rejected — the user explicitly wants context queries out of the global panel and living per-connection.

**Decision: Make `ContextQueriesBranch` the create surface.**
Add a small `New query` control in the branch header (next to the count) that opens a name prompt (reuse the existing `NamePromptDialog` used by the panel today, or a minimal inline input), then calls `contextApi.saveQuery(connectionId, name, "")` and opens the query via the existing `openContextQuery` path (already wired in `ConnectionRow.tsx`). Refresh via the branch's `context://changed` subscription (already present in `useContextQueries`).
- The branch must render when linked-but-empty: change guard 2 (`queries.length === 0 → return null`) to still render the header + `New query` (drop the empty-hide, or show an empty hint).

**Decision: Add a setup CTA to the branch for the unlinked state.**
Change guard 1 (`!contextPath → return null`) to render a compact CTA instead. Extract a shared hook `useContextFolderLink(connectionId)` from `ContextFolderRow` exposing `knownFolders`, `reuse(path)`, `createNew()`, `chooseExisting()`; the branch and `ContextFolderRow` both consume it so behavior stays identical. On success, `context_path` changes on the connection record and the branch re-renders with the query list.
- Alternative considered: keep hiding the branch and rely on the connection form for setup. Rejected — the user wants setup reachable from the branch.
- If the shared-hook extraction proves invasive, the branch may call the `contextApi` methods directly; behavior (not code shape) is what the spec fixes.

**Decision: Retain `context_list_linked_queries` unused.**
Mirrors how `saved_queries_create` was retained. Avoids a backend change and keeps tests green; a later cleanup can remove it.

## Risks / Trade-offs

- **[Local saved queries become create-less]** → Intentional per the user ("keep the globals"). Existing rows remain fully manageable; only creation moves to context folders. If a user has no local queries, the panel is simply empty with a `New folder` action — acceptable.
- **[Branch now renders in more states (empty, unlinked)]** → More surface to style; mitigate by keeping the CTA compact and matching `DESIGN.md`. Guard against noise: only render the unlinked CTA for engines where the branch is mounted and the connection is active.
- **[Duplicating ContextFolderRow logic]** → Mitigated by the shared hook; keep the branch thin.
- **[Two windows]** — the branch is workspace-mode only (`mode === "workspace"`); the manager-window `Sidebar` shows the panel without per-connection subtrees. Context-query creation is therefore a workspace-window action, consistent with today's branch. Note this in QA.

## Migration Plan

Pure frontend change; no data migration. Rollback is a revert of the `SavedQueriesPanel`, `ContextQueriesBranch`, and shared-hook edits. `context_list_linked_queries` stays callable throughout, so no ordering constraints.
