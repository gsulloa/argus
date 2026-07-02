## Context

`ContextQueriesBranch` renders a "New query" button in its header (and a "New query in this folder" button on each folder row) **only when the `onNewQuery` prop is provided** — otherwise just the "New folder" (`FolderPlus`) button shows. Two hosts render the branch:

- `ConnectionRow.tsx` (Manager window) — passes `onNewQuery={makeNewContextQueryHandler(engine)}`, which does `contextApi.saveQuery(id, name, "", { folder })` then `openContextQuery(tabs, id, name, engine, {…})`. Both buttons show.
- `ConnectionSubtree.tsx` (Workspace window) — passes only `onActivate` (which uses the same `openContextQuery` + `useTabs()` it already imports). No `onNewQuery`, so the "New query" button is absent. This is the reported gap.

The new-query button currently uses a generic `Plus` icon; the folder button uses `FolderPlus`. The user wants the new-query affordance to read as a **file** action.

## Goals / Non-Goals

**Goals:**
- The "New query" (new file) affordance appears in the Workspace Context Queries branch, next to "New folder", for Postgres/MySQL/MSSQL/Dynamo.
- The new-query button uses a file icon (`FilePlus`) so it reads as "new file" beside `FolderPlus`.

**Non-Goals:**
- No change to Athena/CloudWatch (they don't render the branch).
- No change to the branch's creation flow, dialogs, or the backend `context_save_query`.
- No refactor to unify `ConnectionRow` and `ConnectionSubtree` (out of proportion; they intentionally keep separate subtree paths).

## Decisions

**Decision: Add an `onNewQuery` handler in `ConnectionSubtree`, mirroring `ConnectionRow`.**
`ConnectionSubtree` already has `useTabs()` and `openContextQuery`; add a small `makeNewContextQueryHandler(engine)` (or an inline per-engine handler) that calls `contextApi.saveQuery(connectionId, name, "", { folder })` and then `openContextQuery(tabs, connectionId, name, engine, { name, path: rel_path, folder, description: null, params: [], tags: [] })`, and pass it to each of the four `<ContextQueriesBranch>` instances. Surface failures via `useToast`.
- Alternative: make the branch render "New query" unconditionally (drop the `onNewQuery` gate). Rejected — the gate is intentional (a host that can't open tabs shouldn't offer creation); wiring the handler is the correct fix and keeps behavior explicit.

**Decision: Swap the new-query icon `Plus → FilePlus`.**
In `ContextQueriesBranch.tsx`, change the header "New context query" button and the per-folder "New query in folder" button to use lucide's `FilePlus`. Keep sizes/stroke consistent with the existing `FolderPlus` usage. The folder button is unchanged.
- Alternative: keep `Plus`. Rejected — the user explicitly wants a file icon so the two affordances read as "new file" / "new folder".

## Risks / Trade-offs

- **[Behavioral drift between Manager and Workspace handlers]** → keep the Workspace handler a faithful copy of `ConnectionRow.makeNewContextQueryHandler` (same `saveQuery` args, same `openContextQuery` shape) so both windows behave identically.
- **[Icon reads as unclear]** → `FilePlus` is the lucide counterpart to `FolderPlus`; paired they clearly mean file vs folder. Follows `DESIGN.md` (single accent, thin strokes) — no new colors.
- **[Existing tests assert the `Plus` new-query button by accessible name]** → the button's `aria-label`/`title` ("New context query") stay the same, so name-based queries keep working; only the icon glyph changes.

## Migration Plan

Frontend-only, no data migration. Rollback removes the `onNewQuery` wiring in `ConnectionSubtree` and reverts the icon.
