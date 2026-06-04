## Context

Two pieces of user feedback (#57, #58) target the Dynamo data view tab (`src/modules/dynamo/data-view/`):

- **#57 — partition-key input too narrow.** `QueryBuilder.module.css` `.textInput` has `min-width: 120px` and no `flex` rule. Inside `.keyRow` (`display: flex; flex-wrap: wrap`), the input defaults to `flex: 0 1 auto` and shrinks to content. Long composite keys (`CLIENT#MEKI-PRODUCT#7292-PRODUCT_B...`) clip and can't be read or audited.
- **#58 — no column sort on the Tabla grid.** `TabView.tsx` (`src/modules/dynamo/data-view/`) headers are plain `<div role="columnheader">` with no `onClick`, and the TanStack Table instance is initialised with only `getCoreRowModel()`. The Postgres grid already implements click-to-sort via a re-query path (`src/modules/postgres/data/sortHelpers.ts`, `useTableOrderBy.ts`) — but DynamoDB Query is ordered by the index's sort key and Scan is unordered, so sort cannot be pushed server-side without buffering everything client-side anyway. Sort must therefore live entirely in the client over the loaded page.

Both fit one PR: same module, same testing surface (the existing `TabView` test plus the new `useDynamoSort` test).

## Goals / Non-Goals

**Goals:**
- Make the partition-key (and sort-key) value editors grow to fill the available row width.
- Add client-side click-to-sort over the loaded Tabla items, with multi-column via `Shift+Click`, an in-header indicator (▲/▼ + ordinal), and persistence per `(connectionId, tableName)`.
- Survive `Load more` correctly — sort applies to the merged list in place.
- Zero AWS-side change.

**Non-Goals:**
- Server-side / `ScanIndexForward` plumbing for arbitrary attributes (not feasible against DDB — see Decisions).
- Sorting in JSON view mode (out of scope; sort applies only to Tabla).
- Sorting on the inspector tree.
- Filter-row value-editor width changes — those rows already wrap cleanly and the proposal is explicitly scoped to key rows.
- Changing the persisted `BuilderState` shape, the Tauri commands, or the activity-log payloads.

## Decisions

### 1. Widen `.textInput` only inside key rows, not filter rows

The simplest CSS fix (`.textInput { flex: 1 }` global to the file) would also expand every filter-row value input, breaking the current filter-row layout where the operator pill, value editor, and per-row Apply button share a single line.

Use a dedicated class — `.keyValueInput` (or `.textInputGrow`) — that applies `flex: 1; min-width: 120px` and is added on the partition-key and sort-key `<input>` elements only. `TypedValueEditor` accepts a `className`/variant prop (or the partition / sort key call sites wrap the editor with a `<div className={styles.keyValueWrap}>` whose `> input` selector applies the rule).

**Alternatives considered:**
- *Global `.textInput { flex: 1 }`*: rejected — breaks filter-row layout.
- *Focus-only expansion*: rejected — the issue reporter wants to see what they typed at idle, not only when focused.
- *Textarea*: rejected — partition keys are conceptually one line, and `Enter` already runs the query (see existing requirement "Plain Enter in filter value input runs the query"). A textarea would break that affordance.

### 2. Client-side sort via TanStack Table's `getSortedRowModel`

TanStack Table already powers the grid. Adding sort means:
- Pass `getSortedRowModel: getSortedRowModel()` (from `@tanstack/react-table`).
- Hoist a `sorting: SortingState` into `DataViewTab` via `useDynamoSort(connectionId, tableName)`, pass it as `state.sorting` to `useReactTable`, and pass `onSortingChange` from the hook so it persists.
- Provide a custom `sortingFn` per column type (numeric vs. lexicographic vs. complex-summary).

**Alternatives considered:**
- *Push sort to DDB via `ScanIndexForward`*: only flips the active index's sort-key direction — useless for arbitrary attributes. Rejected.
- *Compute a sorted view in `DataViewTab` and pass pre-sorted items to TanStack*: workable but duplicates TanStack's sort machinery and complicates virtualization keys. Rejected.
- *Reuse Postgres's `cycleSort`*: similar shape but a different `OrderBy` type, and Postgres's sort is server-side (`ORDER BY` in the SQL). Copying the helper trades a 30-line shared module for cross-module coupling between unrelated DBMS layers. Keep a local `cycleSort` adapted for `SortingState`.

### 3. Type-aware sortingFn keyed on the column's inferred AttributeValue tag

`useInferredColumns` already exposes a `category` per column (`text` | `numeric` | `boolean` | `uuid` | `json` | `binary`). We derive a sortingFn at column-def construction time:

| Category | Comparator |
| --- | --- |
| `numeric` | `parseFloat(a.N) - parseFloat(b.N)`; `NaN` → +∞ asc, -∞ desc |
| `boolean` | `Number(a.BOOL) - Number(b.BOOL)` |
| `text`, `uuid` | `String(a.S ?? a.B).localeCompare(String(b.S ?? b.B), undefined, { numeric: true, sensitivity: "base" })` |
| `json` (`L`, `M`, `SS`, `NS`, `BS`) | sort by summary length (`.L.length`, `.SS.length`, `Object.keys(.M).length`, etc.) |
| `binary` (`B`, primitive) | lexicographic on the base64 string |
| any | `undefined` (missing) always sorts to the "low-priority" end (last asc / first desc) |

The comparator wrapper is the same across columns; only the value-extractor differs. Implement in `dynamoSortHelpers.ts`.

### 4. Shift+Click semantics

TanStack Table's built-in `onSortingChange` mirrors what we want (toggle add vs. replace, cycle through asc/desc/none) but its `enableMultiSort` flag does it via *holding Shift while clicking*, which is exactly the spec. We:

- Set `enableMultiSort: true` on the table instance.
- Set `enableSortingRemoval: true` and `enableMultiRemove: true` so the third click removes the column from the sort.
- Bind header `onClick` to `header.column.getToggleSortingHandler()`, which TanStack provides — it already reads `e.shiftKey`.

This means we do NOT need to hand-roll `cycleSort` for the click handler — TanStack does it. We still keep a tiny `dynamoSortHelpers.ts` for the type-aware comparator factory (decision 3). Cleaner net result.

### 5. Indicator rendering

In the header render, read `header.column.getIsSorted()` (returns `"asc" | "desc" | false`) and `header.column.getSortIndex()` (0-based, -1 if not in sort). Render `▲` / `▼` next to the column name. When `table.getState().sorting.length >= 2`, append the 1-based `getSortIndex() + 1` ordinal.

The indicator goes inside the existing header `<div>`, after the `<span>{header.id}</span>` and before the `ResizeHandle`. Add a small className for the indicator span so it can be styled muted-then-active in `TabView.module.css` per `DESIGN.md` (no decorative gradients, no bubbly radii).

### 6. Resize handle must not trigger sort

`ResizeHandle` already absorbs mousedown for drag, but a plain click bubble can hit the header. Wrap the handle's surrounding span with `onClick={(e) => e.stopPropagation()}`. Verified by the spec scenario "Resize handle does not trigger sort".

### 7. Persisting `SortingState` via `useSetting`

Same pattern as `dynamoColumnWidths:<connectionId>:<tableName>`. Key: `dynamoSort:<connectionId>:<tableName>`. Shape: `Array<{ id: string; desc: boolean }>` (TanStack's `SortingState`). Default: `[]`.

`useDynamoSort` returns `{ sorting, setSorting }` where `setSorting` accepts both a value and TanStack's updater fn — matching the `OnChangeFn<SortingState>` signature — so the hook plugs straight into `useReactTable`'s `onSortingChange`.

### 8. Sort survives Load more (and Run with the same shape)

TanStack's `getSortedRowModel()` recomputes on `data` change. When `useDynamoItems` appends a page, `items` reference changes → TanStack re-sorts the merged list automatically. No extra work needed.

`handleReset` already wipes items via `reset()`; the sort state itself is preserved (it's tab-scoped, not items-scoped). The spec is explicit: changing the builder does NOT clear the sort. This matches user expectation ("I always want quantity desc on this table") and matches the persistence design.

### 9. JSON view does not sort

JSON view is out of scope. The sorting state still persists but is invisible until the user switches back to Tabla. If we wanted to also sort JSON view, we'd need to feed it the sorted row order — explicitly deferred.

## Risks / Trade-offs

- **[Risk] Type inference can be wrong.** `useInferredColumns` infers category from the loaded sample. A column the heuristic marks `text` but that's actually numeric (mixed `S` / `N` items) would sort lexicographically. → **Mitigation:** the comparator falls back gracefully — it always reads the actual AttributeValue tag at compare time, not the inferred category. The inferred category only chooses the *comparator strategy*; numeric/boolean compare functions handle missing `.N` / `.BOOL` by returning `0` (treat as equal), so a mis-categorized column degrades to "loaded order" rather than throwing.
- **[Risk] Performance on large pages.** Sorting 1000 items in JS is sub-millisecond; sorting 10× pages worth (~10k) is still fine for the inspector use case. → **Mitigation:** no extra mitigation needed. If users complain, we can memoize.
- **[Risk] Visual regression on the partition-key row when the row is narrow.** The key row's `keyLabel + badge + input + operator + value` chain already uses `flex-wrap: wrap`. Setting `flex: 1` on the value input could push it onto its own line earlier. → **Mitigation:** verify visually in `design/preview.html` and in QA; if the wrap is ugly, set `flex: 1 1 240px` instead of `flex: 1` so the input gets a comfortable basis before wrapping.
- **[Trade-off] No server-side sort.** Users on tables with millions of rows can't "sort the whole table by quantity desc". This is a known DDB limitation, not an Argus regression. The bottom bar already shows `<N> items loaded` so the user knows what scope they're sorting.

## Migration Plan

No migration. New `useSetting` key; absence → empty default. Existing tabs render identically until the user clicks a header. Rollback = revert the PR; persisted `dynamoSort:*` settings become inert.

## Open Questions

- *Should the sort indicator render at idle when the column is not part of the active sort?* The MySQL/MSSQL/Postgres grids render a faded `↕` glyph on hover to advertise click-to-sort. The Dynamo grid currently has no hover affordance on headers; a hover-only faded indicator would discover the feature without polluting headers. **Recommendation:** ship the active-state indicator first (per spec), defer the hover hint as a follow-up if discoverability is a problem in QA.
