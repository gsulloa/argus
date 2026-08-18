## 1. Fix the shared resize handle

- [x] 1.1 In `packages/app/src/platform/table/ResizeHandle.tsx`, add an `onClick` handler on the handle `<div>` that calls `e.stopPropagation()` unconditionally (no drag-state gate — see design Decision 2). Do **not** add a `mousedown` stop (Decision 3).
- [x] 1.2 In the same file, make `handleDoubleClick` accept the event and call `e.stopPropagation()` before `onReset()`, so neither constituent click of a double-click reaches the header.
- [x] 1.3 Update the component's JSDoc block (currently lists hover / drag / double-click / disabled behaviour) with a line stating that click and dblclick do not propagate to the enclosing header cell, and why (headers carry the sort handler).

## 2. Remove the DynamoDB point fix

- [x] 2.1 In `packages/app/src/modules/dynamo/data-view/TabView.tsx` (~line 599), delete the `<span onClick={stopPropagation} onMouseDown={stopPropagation}>` wrapper and its comment, rendering `<ResizeHandle …/>` directly in the header cell. Keep the `currentWidth` / `onChange` / `onReset` props exactly as they are.
- [x] 2.2 Re-point `packages/app/src/modules/dynamo/data-view/TabView.test.tsx:670-696` ("resize handle click does NOT call onSortingChange") at the handle element itself instead of `querySelector("span:last-child")` — select by the ResizeHandle CSS-module class (e.g. `qtyHeader.querySelector("div[class*='handle']")`). Replace the `if (resizeSpan)` guard with an assertion that the handle was found, so the test cannot pass vacuously.
- [x] 2.3 Re-run `packages/app/src/modules/dynamo/data-view/TabView.resize.test.tsx` and confirm the two structural assertions still hold after the wrapper is gone: "More… column header has no ResizeHandle element" (`div` child count 0) and "resizable columns have a ResizeHandle in their header cell" (`div` child count > 0). Adjust the selectors only if they broke.

## 3. Tests for the new behaviour

- [x] 3.1 In `packages/app/src/platform/table/ResizeHandle.test.tsx`, add a case: render the handle inside a parent element with an `onClick` spy, `fireEvent.click(handle)`, assert the parent spy was **not** called.
- [x] 3.2 Add a case: same setup, `fireEvent.dblClick(handle)`, assert the parent `onClick` spy was not called **and** `onReset` was still called once.
- [x] 3.3 Add a case covering the full gesture: `pointerDown` → `pointerMove` → `pointerUp` → `fireEvent.click(handle)`, assert the parent `onClick` spy was not called and `onChange` received the dragged width (proves resize still works while the sort is suppressed).
- [x] 3.4 Add a grid-level regression test for a server-side grid — `packages/app/src/modules/postgres/data/__tests__/DataGrid.resize.test.tsx` is the natural home: render `DataGrid` with an `onSortChange` spy, locate a column header's handle, run the drag-then-click sequence, and assert `onSortChange` was never called. This is the test that would have caught #277.
- [x] 3.5 Add (or extend) an equivalent assertion for the client-sorted `AdhocResultGrid` in `packages/app/src/modules/postgres/data/AdhocResultGrid.resize.test.tsx`: clicking the handle in a `sortable` result grid must not change the rendered row order or invoke the header sort path.
- [x] 3.6 Add a positive-control assertion in one of the above: clicking the header's column-name `<span>` (outside the hit area) **does** call the sort handler, so the fix cannot silently disable sorting altogether.

## 4. Verify

- [x] 4.1 Run `pnpm -C packages/app typecheck` — the `handleDoubleClick` signature change is the only typing risk.
- [x] 4.2 Run `pnpm -C packages/app test:run` and resolve any failures, paying attention to the DynamoDB suites touched in section 2 and to `DataGrid.contextMenu.test.tsx` (stubs pointer capture for the handle).
- [ ] 4.3 Manual QA in the running app, once per affected grid — Postgres table viewer, Postgres SQL-editor result grid, MySQL grid, MSSQL grid, DynamoDB Tabla view: drag a column edge, release, and confirm the width changed and the sort indicator / row order did **not**, and that no re-query was issued in the three server-side grids.
- [ ] 4.4 Manual QA of the unaffected paths: clicking a header (and shift-clicking in the Postgres grid) still cycles the sort; double-clicking the handle still resets the column to its type-derived width without sorting.
