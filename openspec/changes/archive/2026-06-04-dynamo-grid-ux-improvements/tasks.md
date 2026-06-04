## 1. Widen partition / sort key value inputs (#57)

- [x] 1.1 Add a `.keyValueInput` (grow variant) rule to `src/modules/dynamo/data-view/QueryBuilder.module.css` that sets `flex: 1 1 240px; min-width: 120px` (keep the existing `.textInput` rule untouched so filter rows are unaffected).
- [x] 1.2 Extend `TypedValueEditor` in `src/modules/dynamo/data-view/QueryBuilder.tsx` to accept an optional `variant?: "default" | "grow"` prop and apply `styles.keyValueInput` to the rendered text / number `<input>` when `variant === "grow"`.
- [x] 1.3 In `QueryBuilder.tsx`, pass `variant="grow"` only to the two `<TypedValueEditor>` instances rendered inside the partition-key and sort-key rows (`.keyRow`); filter rows continue to render with the default variant.
- [x] 1.4 Open `design/preview.html` and the running app, verify the partition-key input grows to fill the row at typical tab widths, and that filter-row layout is unchanged.

## 2. Sort hook + helpers (#58)

- [x] 2.1 Create `src/modules/dynamo/data-view/useDynamoSort.ts` exporting `useDynamoSort(connectionId: string, tableName: string)` that returns `{ sorting: SortingState, setSorting: OnChangeFn<SortingState> }`. Persist via `useSetting<SortingState>("dynamoSort:" + connectionId + ":" + tableName, [])`. The returned `setSorting` MUST accept both a value and an updater fn (match TanStack's `OnChangeFn` signature) and forward to the underlying `setSetting`.
- [x] 2.2 Create `src/modules/dynamo/data-view/dynamoSortHelpers.ts` exporting `makeSortingFn(category: ColumnCategory): SortingFn<AttributeMap>` that returns a TanStack-compatible comparator over `AttributeValue | undefined` cells. Implement the type-aware branches per design §3 (numeric `N`, boolean `BOOL`, text / uuid via `localeCompare` with `{ numeric: true, sensitivity: "base" }`, complex `L`/`M`/`SS`/`NS`/`BS` by summary size, binary `B` lexicographic on base64). Treat `undefined` as the low-priority end (always sorts last regardless of direction).
- [x] 2.3 Add unit tests `src/modules/dynamo/data-view/useDynamoSort.test.tsx` covering: default `[]`, persistence round-trip per `(connectionId, tableName)`, isolation between two tables on the same connection, and `setSorting` accepting both value + updater fn.
- [x] 2.4 Add unit tests `src/modules/dynamo/data-view/dynamoSortHelpers.test.ts` covering: numeric ordering (`"2", "10", "3"` → `2, 3, 10`), boolean (`false < true`), text `localeCompare` with `numeric: true` (so `"item2" < "item10"`), complex sort by length, and `undefined` placement asc + desc.

## 3. Wire sort into the Tabla grid (#58)

- [x] 3.1 In `src/modules/dynamo/data-view/DataViewTab.tsx`, call `useDynamoSort(connectionId, tableName)` and pass `sorting` + `onSortingChange` down to `<TabView>` as new props.
- [x] 3.2 Extend `TabViewProps` in `src/modules/dynamo/data-view/TabView.tsx` with `sorting: SortingState` and `onSortingChange: OnChangeFn<SortingState>`.
- [x] 3.3 Update the `useReactTable` call: import `getSortedRowModel` from `@tanstack/react-table`; pass `getSortedRowModel: getSortedRowModel()`, `state: { sorting }`, `onSortingChange`, `enableMultiSort: true`, `enableSortingRemoval: true`, `enableMultiRemove: true`.
- [x] 3.4 In the per-column `ColumnDef` mapping, set `enableSorting: false` on the `MORE_COLUMN_ID` column and `enableSorting: true` (default) on all others. Attach a `sortingFn: makeSortingFn(col.category)` to each non-`More…` column.
- [x] 3.5 In the header render block (around `TabView.tsx:540-580`), bind the header `<div>`'s `onClick` to `header.column.getToggleSortingHandler()` for non-`More…` columns; skip the binding for `MORE_COLUMN_ID`. Read `header.column.getIsSorted()` to render the indicator: `"asc"` → `▲`, `"desc"` → `▼`, `false` → no indicator. When `table.getState().sorting.length >= 2`, render `${arrow} ${getSortIndex() + 1}` for each sorted column.
- [x] 3.6 Add `onClick={(e) => e.stopPropagation()}` (and `onMouseDown={(e) => e.stopPropagation()}` for safety) to the wrapper around `<ResizeHandle>` in the header cell so resize gestures do not toggle sort.
- [x] 3.7 Update `src/modules/dynamo/data-view/TabView.module.css` to add a `.sortIndicator` class (small, color `var(--text-subtle)` when 1-column, `var(--accent)` when ≥2 columns) and a `.headerCell` hover affordance (cursor: pointer; subtle background) per `DESIGN.md`. Skip both on the `More…` column.

## 4. Integration tests (#58)

- [x] 4.1 Extend `src/modules/dynamo/data-view/TabView.test.tsx` (or equivalent) with: plain-click cycles asc → desc → none on a single column; plain-click on a second column replaces (single-column sort moves over); `Shift+Click` adds a tie-breaker column and renders ordinals `1, 2`; clicking the `More…` header is a no-op; clicking the resize handle does not change sort state.
- [x] 4.2 Add a test that asserts sort survives `Load more`: render with 3 items sorted by `quantity desc`, simulate appending 3 more items, verify all 6 are rendered sorted by `quantity desc` in place.
- [x] 4.3 Add a `useDynamoSort` persistence integration assertion (already covered by 2.3, but include a `TabView` test where re-mounting the component with the same `(connectionId, tableName)` restores the previous sort).

## 5. QA pass

- [x] 5.1 Manual QA against a real DynamoDB connection: open a table with long composite partition keys; verify the partition-key input shows the full value at typical tab widths.
- [x] 5.2 Manual QA: load 100+ items into the Tabla grid; click `quantity` header → ascending; click again → descending; click again → unsorted. Shift-click `status` + `quantity` and verify ordinals + tie-break. Click `More…` and verify no-op. Drag a column edge and verify sort is not triggered.
- [x] 5.3 Manual QA: with a sort active, click `Load more`; verify the merged list is rendered in sorted order in place.
- [x] 5.4 Manual QA: close and re-open the tab; verify the sort persists for the `(connectionId, tableName)` tuple and does not leak to other tables.
- [x] 5.5 Run the `dynamo-data-view` test suite (`bun test src/modules/dynamo/data-view/`) and the project's typecheck (`bun run typecheck`) and lint (`bun run lint`). Address any failures before opening the PR.

## 6. PR

- [ ] 6.1 Open a PR titled "Dynamo: widen key inputs and add click-to-sort on result grid (#57, #58)" with a short description linking both issues and the OpenSpec change directory.
