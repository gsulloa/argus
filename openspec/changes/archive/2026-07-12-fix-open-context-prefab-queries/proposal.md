## Why

Opening a context/prefab query from a connection's **Context Queries** sidebar branch (single click or the "Open" context-menu item) silently does nothing — no SQL editor tab appears (GitHub #242, reported in-app on v0.8.1, Postgres). This is the same class of bug fixed for saved queries in #209/#220, reintroduced for context queries by #229: the open path routes the new tab into the target connection's per-connection tab set but never switches focus to that connection, so the tab lands in a hidden set. It works only when the query's connection is already focused, which makes it look intermittent and blocks a core context-folder workflow.

## What Changes

- Thread a focus context (`setFocused`, and `focusedConnectionId`/`isOpen` for parity with the saved-query path) into `openContextQuery`, and call `setFocused(connectionId)` before opening the editor tab for the Postgres, MySQL, and MSSQL cases — mirroring `openSavedQuery.ts`. This guarantees the newly opened tab is surfaced in the now-focused connection instead of landing in a hidden tab set.
- Update the two `onActivate` call sites (`ConnectionSubtree.tsx`, `ConnectionRow.tsx`) to supply the focus context, sourced from the existing `useFocusedConnection()` hook (as `SavedQueriesPanel` already does). Apply the same for the Dynamo and Athena call sites for parity.
- Add regression test coverage asserting that activating a context query for a non-focused-but-connected connection switches focus and surfaces the tab.

No behavior changes to query parsing, disk loading, or execution — the fix is confined to how the opened tab is surfaced.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `context-queries-runner`: the "Open context query in editor tab" requirement gains an explicit guarantee that activating a context query switches focus to the query's connection so the opened tab is surfaced (currently unspecified, which allowed the tab to be routed into a hidden per-connection tab set).

## Impact

- **Frontend only.** No Rust, IPC, or schema changes.
- `packages/app/src/modules/context/openContextQuery.ts` — accept focus context; call `setFocused` before opening the tab (postgres/mysql/mssql cases).
- `packages/app/src/platform/shell/ConnectionSubtree.tsx` and `packages/app/src/platform/shell/ConnectionRow.tsx` — pass focus context into `openContextQuery` at all engine call sites.
- Tests: `ContextQueriesBranch.test.tsx` / `ConnectionSubtree.test.tsx` (or a dedicated `openContextQuery` test) — add the focus-switch regression case.
- Affected engines: Postgres (reported), MySQL, MSSQL (same code path). Dynamo/Athena/CloudWatch unaffected in symptom but updated for call-site parity.
