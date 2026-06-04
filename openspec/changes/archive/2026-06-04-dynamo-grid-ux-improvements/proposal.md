## Why

Two pieces of user feedback on the Dynamo data view block normal inspection work:

- **#57** — the partition-key value input in the Query builder is too narrow to read or edit long composite keys like `CLIENT#MEKI-PRODUCT#7292-PRODUCT_B...`, so users can't see what they typed.
- **#58** — the Tabla result grid has no way to sort. DynamoDB Query orders by the index's sort key and Scan is unordered, so the only sane place to add column sort is client-side over the loaded page. Users today can't see "rows with highest quantity" without exporting or eyeballing.

Both are local UX gaps in the same tab; bundling them lets us touch the query builder and the results grid in one coherent pass.

## What Changes

- **Query builder partition / sort key inputs grow to fill the row.** The text and number value editors used for partition / sort keys SHALL stretch (`flex: 1`) inside their key row instead of shrinking to content. Filter-row value editors keep current sizing. No DSL or behavior change.
- **Tabla grid gains click-to-sort on column headers.** Client-side only (no AWS round-trip). Click cycles `asc → desc → none`; `Shift+Click` adds a column to a multi-column sort. The `More…` column is not sortable. Sort state persists per `(connectionId, tableName)`.
- **Sort indicators in the header.** An arrow (▲ / ▼) renders next to the column name when a column is part of the active sort; when ≥2 columns are sorted, an ordinal `1, 2, …` renders next to each arrow.
- **Sort survives `Load more`.** New pages are merged and re-sorted in place; sort state is NOT cleared when items are appended or when the builder is re-run with the same shape.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `dynamo-data-view`: adds the new "Tabla column sort" requirement on the Tabla view mode (click-to-sort over loaded items, persisted per table).

## Impact

- **Code**:
  - `src/modules/dynamo/data-view/QueryBuilder.module.css` — widen `.textInput` (or introduce `.textInputGrow` variant) on the key-row value editors.
  - `src/modules/dynamo/data-view/QueryBuilder.tsx` — apply the grow variant only inside the partition / sort key rows (not filter rows).
  - `src/modules/dynamo/data-view/TabView.tsx` — wire `getSortedRowModel()`, `sortingState`, header `onClick` cycling, and indicator rendering; guard the resize handle from header-click bubbling.
  - `src/modules/dynamo/data-view/TabView.module.css` — header hover affordance + sort-indicator styles.
  - `src/modules/dynamo/data-view/DataViewTab.tsx` — own sort state via a new `useDynamoSort(connectionId, tableName)` hook, pass `sorting` + `onSortingChange` to `TabView`.
  - new: `src/modules/dynamo/data-view/useDynamoSort.ts` — persistence via `useSetting` under key `dynamoSort:<connectionId>:<tableName>`.
  - new: `src/modules/dynamo/data-view/dynamoSortHelpers.ts` — `cycleSort` adapted for `SortingState` shape from `@tanstack/react-table`. (Postgres's helper lives in its own module; copying keeps modules decoupled, consistent with the rest of the Dynamo data view.)
- **APIs / Tauri commands**: none. No backend changes.
- **Settings**: introduces a new `useSetting` key `dynamoSort:<connectionId>:<tableName>`; default `[]`.
- **No breaking changes**, no migration. Existing tabs render exactly as before until the user clicks a header.
- **Tests**: new unit tests for `cycleSort` and `useDynamoSort`; integration coverage by extending the existing `TabView` test (header click cycles and persists, `More…` is not sortable, sort survives `Load more`).
