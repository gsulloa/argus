## Why

After shipping the filter bar (`table-filter-bar`), the bar's `draft` and `applied` state lives in `TableViewerTab`'s `useState`. Argus's `TabContent` only mounts the *active* tab — switching to a different tab unmounts the previous tab's component, dropping all React state. So switching tabs (or closing and reopening the same table) silently resets the filter, contradicting the user's mental model: "the filter belongs to this table". The user has explicitly asked that filters never reset unless reset is requested manually.

## What Changes

- Hoist filter state out of `TableViewerTab`'s `useState` into a per-`(connectionId, schema, relation)` registry, so it survives tab switches, tab-close-and-reopen, and app restarts.
- Persist `draft` AND `applied` (separately) so an in-progress (uncommitted) draft survives a tab switch the same way the applied filter does.
- Add a `useTableFilter(connectionId, schema, relation)` hook mirroring the shape of `usePageSize` and backed by the same `useSetting` pipeline (in-memory + debounced disk write).
- Treat the existing `Reset` action and the BottomBar's "Clear filters" affordance as the *only* paths that clear the persisted filter. Tab switches, tab close, app restart, and re-opening the same relation MUST preserve the persisted filter.
- Surface schema-drift failures (filter references a since-removed column) as the same `AppError::Postgres` the user already sees today; do not auto-prune the persisted filter.
- (Carry-along) Apply the same persistence to `orderBy` for parity — it has the same UX problem (tab switches reset sort), and the storage cost is trivial.

## Capabilities

### New Capabilities
_(none — this change extends an existing capability.)_

### Modified Capabilities
- `postgres-data-grid`: changes the lifetime of `draft` / `applied` filter state and `orderBy` from per-tab-mount to per-`(connection, schema, relation)`. Adds a persistence layer and explicit "manual reset only" semantics.

## Impact

**Frontend**
- Add `src/modules/postgres/data/useTableFilter.ts` (parallel to `usePageSize.ts`). Backed by `useSetting` with a stable key `pgTableFilter:${connectionId}:${schema}:${relation}`.
- Update `TableViewerTab.tsx` to consume `useTableFilter` instead of `useState<FilterModel>` for `draft` / `applied`. Remove the local `useState` for both.
- Either extend `useTableFilter` to also persist `orderBy`, or add a sibling `useTableOrderBy` hook on the same persistence pipeline.
- Update `useTableData`'s effect dependencies — they already use `applied` as a JSON key, so persistence is transparent there. Verify the first-mount race with the disk loader doesn't cause a spurious "no filter" fetch followed by an "actual filter" fetch.

**Backend**
- No backend changes. The wire payload shape is unchanged (`{ filter_tree?, raw_where? }`).

**Tests**
- New unit tests for `useTableFilter` (round-trip persistence, default value, write-coalescing).
- New component test asserting state survives unmount-remount of `TableViewerTab` for the same `(connection, schema, relation)`.

**Out of scope (call out)**
- Saved/named filter recipes (still deferred — this is "implicit persistence", not "named library").
- Garbage-collecting persisted filters for relations that no longer exist (no cleanup pass; the LRU bound on `useSetting`'s memory cache is not addressed here).
- Cross-connection filter sharing — each `(connectionId, schema, relation)` keeps its own state, identical to `usePageSize`.
- Migrating filters when the schema changes (column rename, type change). The existing Postgres-error UX surfaces drift; we don't auto-rewrite.
- An explicit "saved filter" UI gesture (e.g. star a filter, name it, recall it). This change is purely about the implicit per-table memory.
