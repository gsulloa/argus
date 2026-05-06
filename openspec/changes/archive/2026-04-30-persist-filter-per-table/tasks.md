## 1. Persistence hooks

- [x] 1.1 Add `src/modules/postgres/data/useTableFilter.ts` exporting `useTableFilter(connectionId: string, schema: string, relation: string): { draft, applied, isLoaded, setDraft, setApplied, reset }`. Persist the pair as one record under `pgTableFilter:${connectionId}:${schema}:${relation}` via `useSetting<{ draft: FilterModel; applied: FilterModel }>`. Default value: `{ draft: EMPTY_FILTER_MODEL, applied: EMPTY_FILTER_MODEL }`.
- [x] 1.2 In `useTableFilter`, expose an `isLoaded` flag (initially `false`, flips `true` after the disk read completes — or on first render in non-Tauri runtimes). This flag gates the data grid's first-page fetch (D3).
- [x] 1.3 Add `src/modules/postgres/data/useTableOrderBy.ts` exporting `useTableOrderBy(connectionId, schema, relation): { orderBy, isLoaded, setOrderBy }`. Persist under `pgTableOrder:${connectionId}:${schema}:${relation}` via `useSetting<OrderBy[]>`. Default `[]`.
- [x] 1.4 (If `useSetting` does not currently expose a `loaded` flag) extend `useSetting` to return a third tuple element `loaded: boolean` that flips after the first disk read resolves. Update its `usePageSize` consumer to ignore the new element (or destructure-and-discard) for backwards compatibility.

## 2. Wire `TableViewerTab` to the persistence hooks

- [x] 2.1 Replace `useState<FilterModel>(EMPTY_FILTER_MODEL)` for `draft` and `applied` with `useTableFilter(connectionId, schema, relation)`. Remove the local `useState` for both.
- [x] 2.2 Replace `useState<OrderBy[]>([])` with `useTableOrderBy(connectionId, schema, relation)`.
- [x] 2.3 Wire the `Reset` action (`onResetFilters` in `TableViewerTab`) to call the hook's `reset()` so the persisted record is cleared in one update.
- [x] 2.4 Wire the bottom bar's `Clear filters` chip to the same `reset()` (it already calls `onResetFilters`, just verify after the refactor).
- [x] 2.5 Gate the initial first-page fetch in `useTableData` on `useTableFilter`'s `isLoaded` flag — pass `applied` only after the disk read has resolved, so we don't issue a spurious empty-applied fetch ahead of a non-empty persisted filter.

## 3. Avoid the double-fetch on first mount

- [x] 3.1 Update `useTableData` to accept an optional `enabled: boolean` (or equivalent gating) parameter that defers the first-page fetch until `true`. Default `true` for callers that don't pass it.
- [x] 3.2 In `TableViewerTab`, pass `enabled: filterLoaded && orderByLoaded` so the buffer waits until persisted state has loaded. The "loading-first" status should appear immediately and stay until the real fetch resolves; do not regress the existing first-paint behavior.
- [ ] 3.3 Manual smoke: open a table with a non-empty persisted filter and confirm the first page shows the filtered rows on the first paint (no flash of unfiltered rows, no `applied = empty` request hitting the wire). _(Pending live smoke; covered by automated test 4.5.)_

## 4. Tests

- [x] 4.1 Unit-test `useTableFilter`: starts at `EMPTY_FILTER_MODEL`, persists a non-empty model through `setApplied`, surfaces `isLoaded === true` after a tick, and `reset()` returns it to the empty model.
- [x] 4.2 Unit-test `useTableOrderBy`: same shape, default `[]`, round-trip `[{ column: "created_at", direction: "desc" }]`.
- [x] 4.3 Component test: render `TableViewerTab` (mocked `dataApi`), apply a filter, unmount, remount with the same `(connectionId, schema, relation)`, assert the bar comes back with the same `applied` and `draft`.
- [x] 4.4 Component test: same flow but switch the `connectionId` between mounts; assert the second mount sees the empty model (per-connection scope).
- [x] 4.5 Component test: render with a persisted filter, assert no `dataApi.queryTable` call fires before `isLoaded` flips, and after it flips, exactly one call fires with `filter_tree` populated (no double fetch).
- [x] 4.6 Component test: persistence survives tab close + reopen — render `TableViewerTab` for `(c, s, r)`, apply a filter, unmount; render a fresh `TableViewerTab` for the same `(c, s, r)`; assert the new instance reads the same `applied`. _(Covered by 4.3 — the same render/unmount/remount cycle on the same key.)_

## 5. Spec sync and docs

- [x] 5.1 Run `openspec validate persist-filter-per-table --strict --type change` and address any drift.
- [ ] 5.2 Manual smoke matrix: (a) tab switch, (b) tab close + reopen, (c) app restart, (d) two connections same relation, (e) Reset clears, (f) BottomBar Clear filters clears, (g) schema drift surfaces a Postgres error and does NOT clear the persisted record. _(Pending live smoke.)_
- [x] 5.3 No DESIGN.md changes expected — the bar's visual surface is unchanged. If a "stale filter" affordance is added later (e.g., a "Reset persisted filter" command palette action), capture in a follow-up change.
