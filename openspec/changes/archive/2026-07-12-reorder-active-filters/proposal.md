## Why

Users organize the filter bar to reason about their data, but today the order of
filter rows is fixed by insertion order — once a row is added it cannot be moved.
In-app feedback (issue #244) asked to be able to reorder the active filters "by
column" so the list reflects the user's own priority/grouping. Because all rows
join under a single `AND`/`OR` root combinator, reordering is purely
organizational and never changes which rows are returned — making this a safe,
low-risk UX improvement.

## What Changes

- Add **drag-and-drop reordering** of rows in the Postgres data-grid filter bar.
  Each `ConditionRow` gains a dedicated drag handle; dragging a row and dropping
  it commits the new order to the filter `draft`.
- Reordering is treated as an ordinary draft edit: it updates `draft` only, marks
  the bar dirty, and persists with the existing per-table filter storage. Applying
  is not required for correctness (results are order-independent) but the standard
  Apply flow syncs the order into `applied`.
- Add keyboard-accessible reordering via the drag handle (dnd-kit `KeyboardSensor`),
  so keyboard users can move a row up/down without a pointer.
- Introduce a client-only stable per-row identity so the sortable list has stable
  keys. This identity is never emitted on the wire and never affects dirty
  detection or the per-row "Applied" badge.
- No backend, SQL, or query-execution changes. Row order continues to compile into
  the `filter_tree` children in list order, which is semantically irrelevant for
  the flat root combinator.

Out of scope: the MySQL and MS SQL Server filter bars are separate, older
single-file implementations and are not changed here (tracked as a possible
follow-up once they converge on the Postgres bar).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `postgres-data-grid`: the filter bar gains a requirement that filter rows are
  reorderable via drag-and-drop (and keyboard), that reordering is a draft-only
  edit which does not change query results, and that each row carries a
  client-only stable identity for the sortable list.

## Impact

- **Frontend (`packages/app`):**
  - `src/modules/postgres/data/filter-bar/FilterBar.tsx` — wrap the rows list in
    `DndContext` + `SortableContext` (vertical strategy), handle `onDragEnd`.
  - `src/modules/postgres/data/filter-bar/ConditionRow.tsx` — `useSortable`, render
    a drag handle, apply transform/transition styles.
  - `src/modules/postgres/data/filter-bar/treeMutations.ts` — new pure `moveRow`
    helper (+ tests).
  - `src/modules/postgres/data/types.ts` — add client-only `id` to `FilterRow`;
    `EMPTY_FILTER_ROW`/`addRow` mint fresh ids.
  - `src/modules/postgres/data/filter-bar/migrateLegacyFilterModel.ts` +
    `useTableFilter.ts` normalization — backfill missing ids on load.
  - `FilterBar.module.css` — drag-handle and dragging styles per `DESIGN.md`.
- **Dependencies:** none added — `@dnd-kit/core`, `@dnd-kit/sortable`,
  `@dnd-kit/utilities` are already present and used by the connection sidebar.
- **Persistence/wire:** no schema change on the wire; the persisted per-table
  filter record gains the client-only `id` field (backfilled on read).
