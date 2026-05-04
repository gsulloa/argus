## Why

After landing `table-structure-tab`, opening table B's Structure or Raw subtab still shows table A's structure when the user has previously visited Structure on table A. The DDL block, columns table, and FK chips all reflect the wrong relation, so the subtab silently lies until the user notices and clicks **Refresh**.

Root cause: `useTableStructureCache(connectionId, schema, relation)` keeps its `state` in `useState` and never resets when its `(connectionId, schema, relation)` arguments change. The hook's author assumed each `TableViewer` instance corresponds to a single relation — but `TabContent` renders `<Renderer tab={active} />` with the same `TableViewerTab` component for every `postgres-table-data` tab, so React reuses the same fiber across tab switches and the cached `response` survives. This is the same class of bug fixed in `fix-stale-tab-state` for the filter / sort hooks; the structure cache was added later and inherited the same broken assumption.

The trigger condition is common: any user with two open table tabs who has loaded Structure on the first one will see stale data on the second's first paint of Structure or Raw.

## What Changes

- **Reset the structure cache on argument change.** `useTableStructureCache` MUST detect when its `(connectionId, schema, relation)` triple changes and reset `state` to `{ status: "idle", response: null, error: null }` synchronously before the next render commits. Any in-flight fetch from the previous triple MUST be ignored (cancellation token bumped, late responses dropped) so a slow response from table A cannot land in table B's cache.
- **Remove the incorrect comment in `useTableStructureCache.ts`** that asserts `TableViewer never re-mounts with a different (connectionId, schema, relation) triple — each table tab has its own TableViewer instance`. Replace with a brief note on the actual invariant (cache resets on arg change; the component instance is shared across tabs).
- Add a regression test mirroring `fix-stale-tab-state`'s `useSetting` test: render the hook with `(conn, "public", "A")`, drive it to `ready`, rerender with `(conn, "public", "B")`, assert `state.status === "idle"` and `state.response === null` on the next render — and that a follow-up `ensureLoaded` dispatches against `B`, not `A`.

## Capabilities

### New Capabilities
_(none — this change fixes existing capabilities.)_

### Modified Capabilities

- `postgres-table-structure`: tightens the **Per-tab structure cache** requirement so that the cache is keyed on `(connectionId, schema, relation)` and MUST be re-derived when those props change, not just on tab close / re-open. The original requirement only spelled out the two-tabs-of-the-same-relation case; it left the same-tab-different-relation case (which actually happens on every tab switch) ambiguous.

## Impact

**Frontend**

- `src/modules/postgres/structure/useTableStructureCache.ts` — detect arg change in render (compare against a `useRef` of the last key) and reset `state` + bump a generation counter. Drop the in-flight `dispatch` results when `generation` advanced. Update the misleading comment.
- `src/modules/postgres/structure/useTableStructureCache.test.ts` — add a "resets on relation change" case (mirrors the existing 4 cases' style).

**Backend**

- No changes.

**Tests**

- New unit test in `useTableStructureCache.test.ts` for the relation-change reset.
- Optional: a `TableViewerTab` integration test that asserts switching between two `postgres-table-data` tabs and clicking Structure on each shows each tab's own DDL — gated on whether the existing test scaffolding makes that easy. If not, defer to manual QA.

**Out of scope (call out)**

- Refactoring `TabContent` to apply `key={active.id}` on the renderer — would also fix the bug, but resets *all* per-tab in-memory state (edit buffer, scroll, selected row), which we want to keep. Same trade-off the `fix-stale-tab-state` change called out.
- Touching `useTableData`, `useTableFilter`, `useTableOrderBy`, `useTablePrimaryKey`, `usePageSize`, `useEditBuffer` — these already reset correctly (filter/sort via `useSetting` post-`fix-stale-tab-state`; `useTableData` via its `depsKey` reset effect; PK / page-size via `useSetting`; edit buffer is keyed on the tab id and intentionally survives unrelated re-renders).
- Re-architecting the cache to be scoped at a higher level (e.g. a `TableViewer` provider) — overkill for the fix.
