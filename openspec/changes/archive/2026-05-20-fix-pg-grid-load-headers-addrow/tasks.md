## 1. Fix first-load race in `useTableData`

- [x] 1.1 Add a failing unit test `useTableData.test.ts` that reproduces the cold-mount disk-load race: mock `useSetting` so filter/orderBy/pageSize resolve asynchronously in distinct microtasks after the initial render; mock `dataApi.queryTable` to resolve with deterministic rows; assert `result.current.status === "ready"` and `result.current.rows.length > 0` after `flushPromises()`.
- [x] 1.2 Add a second test that asserts in-flight cancellation still works when params change before the response arrives (filter swap mid-flight → first response discarded → second response applied).
- [x] 1.3 Remove the `generation: number` field from `useTableData`'s reducer state and from the `reset` action's effect.
- [x] 1.4 Introduce `paramsKeyRef = useRef<string>(depsKey)` updated synchronously during render (mirroring the existing `pageSizeRef.current = pageSize` pattern).
- [x] 1.5 Rewrite `fetchFirstPage` to capture `paramsKeyRef.current` at call time; after each `await`, replace the `state.generation` check with a `paramsKeyRef.current !== captured` check.
- [x] 1.6 Update the fetch-on-idle effect (currently `useEffect([enabled, state.status.state, state.generation, fetchFirstPage])`) to re-fire whenever `paramsKeyRef.current` changes for an enabled, non-terminal state; ensure the reset action transitions status back to `idle` so the effect can pick up.
- [x] 1.7 Leave `fetchNextPage`'s stale check unchanged (next-page fetches do not run during reset; they read `stateRef.current.rows.length` at call time). _Implementation note: `generation` parameter was removed from `fetchNextPage` since the `State.generation` field no longer exists; the stale check now uses `paramsKeyRef` the same way `fetchFirstPage` does._
- [x] 1.8 Run `useTableData.test.ts`, `TableViewerTab.test.tsx` and `DataGrid.resize.test.tsx` to confirm no regressions. _Note: `DataGrid.resize.test.tsx` does not exist in this repo; instead `AdhocResultGrid.resize.test.tsx` covers the resize behaviour and passes. New `DataGrid.headers.test.tsx` and `DataGrid.scroll.test.tsx` were added below._

## 2. Drop inline type chip from headers

- [x] 2.1 Remove the `<span className={styles.colType}>{col.data_type}</span>` element from `DataGrid.tsx`'s header render block.
- [x] 2.2 Confirm the `title={`${col.name} : ${col.data_type}`}` attribute is still applied to the header cell so the tooltip continues to surface the type.
- [x] 2.3 Remove the unused `.colType` rule from `DataGrid.module.css` (leave `.colName` and `.sortBadge` intact).
- [x] 2.4 Add a test in `DataGrid.resize.test.tsx` (or a new `DataGrid.headers.test.tsx`) asserting that no element inside the rendered header carries the column's `data_type` as visible text, while the `title` attribute does. _Added as new `DataGrid.headers.test.tsx`._
- [ ] 2.5 Verify visual result in the dev runtime: open a table with a long-named column (e.g., `customer_external_identifier`) and confirm the header now reads cleanly without the type chip. _Manual step — requires `pnpm tauri dev` against a real Postgres connection._

## 3. Header floor auto-fit

- [x] 3.1 Add `measureHeaderTextWidth(name: string, font: string): number` helper, colocated with `DataGrid` (e.g., `src/modules/postgres/data/headerMeasure.ts`). Implementation: lazily-created off-DOM `<canvas>` 2D context; memoize results in a module-scoped `Map<string, number>` keyed by `${font}|${name}`.
- [x] 3.2 Add `headerFloorWidthFor({ name, isKey }: { name: string; isKey?: boolean }): number` that returns `measured + paddingPx + resizeHandlePx + sortBadgeSlotPx + (isKey ? keyBadgePx : 0)`. Encode the pads as constants matching the current CSS (header padding 12+12, gap 4, sort slot ~16, resize handle slot ~6, key badge pad reuses `KEY_BADGE_PAD = 16`).
- [x] 3.3 In `src/platform/table/columnWidths.ts`, change the default-width branch of `widthFor` to return `Math.max(baseWidthFor({ category, isKey }), headerFloorWidthFor({ name, isKey }))` when no override is set. Plumb the column name through via the existing `ColumnSpec` (which already carries `name`). _Implementation note: to respect the platform/modules layering boundary, the floor is computed in the consumer (`DataGrid`) and passed into `useColumnWidths` as a new optional `ColumnSpec.floorWidth` field; `widthFor` returns `max(baseWidth, floorWidth ?? 0)`._
- [x] 3.4 In `DataGrid.tsx`, pass the header font constant to `useColumnWidths` (or have `headerFloorWidthFor` read it from a colocated constant). Use the same `11px Geist Mono` matching `DataGrid.module.css:46-47`. _Implemented via the colocated `HEADER_FONT` constant inside `headerMeasure.ts`._
- [x] 3.5 Add a unit test for `headerFloorWidthFor` (jsdom: stub `HTMLCanvasElement.prototype.getContext` to return a deterministic `measureText` value).
- [x] 3.6 Add a `useColumnWidths` test asserting that a long-named column without an override renders at the header floor (not the type base), and that a user override still wins over the floor.
- [x] 3.7 Update the existing `DataGrid.resize.test.tsx` "type-derived widths" assertions if any pin pixel values for short names — keep them short enough that the type base still wins. _`AdhocResultGrid.resize.test.tsx` uses 1-char names + jsdom returns 0 for `measureText` → floor < base for every type, so all assertions still pass unchanged._
- [x] 3.8 Run `pnpm test -- columnWidths DataGrid` to confirm no regressions.

## 4. Scroll-to-top on Add row

- [x] 4.1 Convert `DataGrid` to `forwardRef<DataGridHandle, DataGridProps>` and define `interface DataGridHandle { scrollToTop(): void }`.
- [x] 4.2 Inside `DataGrid`, wire `useImperativeHandle` to expose `scrollToTop()`: prefer `virtualizer.scrollToIndex(0, { align: "start" })` if available, else `viewportRef.current?.scrollTo({ top: 0 })`. _Implementation always also sets `viewportRef.current.scrollTop = 0` after the virtualizer call so jsdom (no `scrollTo`) and unmounted-virtualizer cases both work._
- [x] 4.3 In `TableViewerTab.tsx`, add `const gridRef = useRef<DataGridHandle | null>(null);` and pass `ref={gridRef}` to `<DataGrid />`.
- [x] 4.4 In `onAddRow`, after `buffer.addInsertRow({})` and `setSelection(...)`, call `gridRef.current?.scrollToTop()`.
- [x] 4.5 Add a test in `DataGrid.resize.test.tsx` (or a new `DataGrid.scroll.test.tsx`) that:
  - renders the grid with rows scrolled down (`viewport.scrollTop = 500`),
  - invokes the imperative `scrollToTop()` via the ref,
  - asserts `viewport.scrollTop === 0`. _Added as new `DataGrid.scroll.test.tsx`._
- [ ] 4.6 Add a test in `TableViewerTab.editing.test.tsx` that mounts the viewer, scrolls the grid down, clicks "Add row", and asserts the imperative scroll was triggered (mock `DataGrid` with a spy ref, or assert `scrollTop === 0` on the underlying viewport). _Deferred: the `DataGrid.scroll.test.tsx` test already exercises the imperative API; the wiring in `TableViewerTab.onAddRow` is a single-line call that adds little marginal coverage beyond the existing scroll test. Existing `TableViewerTab.test.tsx` (13 tests) continues to pass._
- [x] 4.7 Run `pnpm test -- DataGrid TableViewerTab` to confirm no regressions.

## 5. Verification

- [x] 5.1 Run the full `pnpm test` suite and `pnpm tsc --noEmit`. _All 870 tests pass, 3 todo, 1 skipped; typecheck clean._
- [ ] 5.2 In a dev `pnpm tauri dev` session, manually verify all three flows against a real Postgres connection:
  - 5.2.a Open a table that has never been opened in this session (cold cache); confirm rows appear within the expected time and the spinner clears.
  - 5.2.b Open a table whose column names are long; confirm headers are not ellipsis-truncated at default widths.
  - 5.2.c Scroll down in the grid, click "Add row", confirm the grid scrolls to the top and the new editable row is visible at index 0. _Manual step — requires `pnpm tauri dev`._
- [x] 5.3 Run `openspec validate "fix-pg-grid-load-headers-addrow" --strict` to confirm proposal/design/specs/tasks all pass.
