## Context

Argus renders tabs per-connection: `TabsContext.open()` resolves a target connection key from the tab payload (`connectionId`, falling back to `initialConnectionId` — the #209 fix) and appends the tab to *that connection's* tab set. Only the **focused** connection's set is rendered. So a tab can be created correctly yet remain invisible if its connection isn't the focused one.

Saved queries hit this exact bug and fixed it twice: #209 added the `initialConnectionId` routing fallback, and #220 added an explicit focus switch (`ctx.setFocused(conn.id)` in `openSavedQuery.ts`) so the tab surfaces in a non-focused connection.

The per-connection **Context Queries** branch was introduced later by #229, which added `packages/app/src/modules/context/openContextQuery.ts`. That open path routes via `initialConnectionId` (so #209 is honored) but **never switches focus** — its `TabsApi` interface doesn't even expose `setFocused`. Result: clicking a prefab query works only when its connection is already focused; otherwise the tab lands in a hidden set and the user sees nothing (#242). The sidebar renders a `ConnectionRow` per connection, so non-focused-but-connected connections show a clickable Context Queries branch — precisely the failing case.

Query body loading is not implicated: `contextApi.getQuery` → `context_get_query` returns the parsed `QueryDoc` with `body` populated, and the `if (!doc) return;` guard is not the failure point.

## Goals / Non-Goals

**Goals:**
- Activating a context query surfaces its editor tab regardless of which connection is currently focused, matching saved-query behavior.
- Fix is confined to the frontend open path and its call sites; parity across Postgres/MySQL/MSSQL (and call-site parity for Dynamo/Athena).
- Add a regression test that would have caught #242.

**Non-Goals:**
- No changes to query parsing, disk loading, execution, or the Rust `context_get_query` command.
- No change to tab routing (`extractConnectionId`) or the tab model itself.
- No rework of the Context Queries branch UI, folders, or drag-and-drop.

## Decisions

**Decision: Mirror `openSavedQuery.ts` — thread a focus context into `openContextQuery` and call `setFocused(connectionId)` before opening the tab.**
- Rationale: This is the proven fix from #220 for the identical bug. Reusing the same shape (`{ focusedConnectionId, setFocused, isOpen }`) keeps the two open paths consistent and easy to reason about.
- The focus switch happens *before* `openQueryTab` / `openMysqlQueryTab` / `openMssqlQueryTab` so the tab is appended to the now-focused set and rendered immediately.
- A context query's connection is always a connected connection whose branch is visibly rendered, so `setFocused(connectionId)` can be called unconditionally (the connection is guaranteed open). We still pass `isOpen`/`focusedConnectionId` for symmetry and defensive guarding, matching `openSavedQuery.ts:92-93`.
- Alternatives considered:
  - *Route the tab and rely on the user to switch connections* — rejected; that's the current broken behavior.
  - *Have `TabsContext.open()` auto-focus the target connection for every tab* — rejected; too broad, changes global tab behavior and risks regressions in flows that intentionally open background tabs.

**Decision: Update all engine call sites in `ConnectionSubtree.tsx` and `ConnectionRow.tsx`, sourcing focus from `useFocusedConnection()`.**
- Rationale: Both hosts already have (or can trivially obtain) the focused-connection context, exactly as `SavedQueriesPanel` does. Passing it through avoids a hidden global dependency inside `openContextQuery`.

## Risks / Trade-offs

- [Focus steals from the user's current connection when they click a prefab query under another connection] → This is the intended, expected behavior (you clicked it, you want to see it), and it matches saved queries. Acceptable.
- [Call-site drift — a future engine added without the focus context] → Mitigated by making the focus context a required argument of `openContextQuery` so the type checker flags any call site that omits it.
- [Regression scope] → Frontend-only, no IPC/schema change, so rollback is a trivial revert.

## Migration Plan

Standard code change; no data migration. Ship in the next patch release. Rollback = revert the commit.
