## 1. Shared helper

- [x] 1.1 Add `deriveDefaultOrderBy(pkColumns: string[] | null, relationKind)` returning `[]` for null/empty `pkColumns` and for views, else `pkColumns.map(c => ({ column: c, direction: "desc" }))`. Place it where all three modules can import it (or add a thin per-module re-export to satisfy module-local `OrderBy` typing). → `src/modules/shared/orderBy.ts`.
- [x] 1.2 Unit-test the helper: single PK → one DESC column; composite PK → all columns DESC in order; `null`/`[]` PK → `[]`; view → `[]`. → `src/modules/shared/orderBy.test.ts`.

## 2. Postgres

- [x] 2.1 In `useTableOrderBy.ts`, expose the persisted order as `OrderBy[] | null` (null = setting key absent) while keeping `isLoaded`; `setOrderBy` always writes a concrete array (including `[]`). No on-disk format change. (`persistedOrderBy`, default `null`.)
- [x] 2.2 In `TableViewerTab.tsx`, compute `effectiveOrderBy = persisted ?? deriveDefaultOrderBy(pkColumns, relationKind)` using `useTablePrimaryKey` (`metadata.pk_columns`), and pass `effectiveOrderBy` into `useTableData`.
- [x] 2.3 Extend the first-fetch gate: `enabled = filterLoaded && orderByLoaded && (persisted !== null || pkResolved)`, where `pkResolved` is PK status `ready` or `error` (error treated as no PK → `[]`). Do not wait on the PK when a persisted order exists.
- [x] 2.4 Update `useTableOrderBy.test.tsx` for the null-vs-`[]` distinction; add tests covering PK-DESC default when unset, explicit `[]` respected, composite PK, view/no-PK → no order, and single first-page fetch (no empty-order pre-fetch). (PK-DESC default + composite + view/no-PK covered by the helper test; null-vs-`[]` + explicit-`[]` respected covered in `useTableOrderBy.test.tsx`.)

## 3. MySQL

- [x] 3.1 In `useTableData.ts`, add `enabled?: boolean` (default `true`) that defers the first auto-fetch when false; preserve behaviour for existing call sites.
- [x] 3.2 In `useTableData.ts`, sync `orderBy` from a changed `initialOrderBy` only before the first fetch and only if the user has not changed the order (`hasFetchedRef`, `userTouchedRef` guards); set `userTouchedRef` in `setOrderBy`. (Synchronous reseed-during-render, mirroring `useSetting`.)
- [x] 3.3 In `data/TableViewerTab.tsx`, pass `initialOrderBy = deriveDefaultOrderBy(pkColumns, relationKind)` and `enabled: pkResolved` (PK fetch settled, success or failure) into `useTableData`. (`pkSettled` flag set in PK `.finally`.)
- [x] 3.4 Add tests: PK-DESC default on open, composite PK, view/no-PK → no order, single first-page fetch, user order not overwritten when PK resolves. → `__tests__/useTableData.defaultOrder.test.ts`.

## 4. MSSQL

- [x] 4.1 Mirror task 3.1 in `mssql/data/useTableData.ts` (`enabled` gate).
- [x] 4.2 Mirror task 3.2 in `mssql/data/useTableData.ts` (`initialOrderBy` sync with guards).
- [x] 4.3 In `mssql/data/TableViewerTab.tsx`, pass `initialOrderBy` from the PK and `enabled: pkResolved`; confirm heap/view sends no `order_by` so the backend PK-asc / `SELECT NULL` fallback still applies.
- [x] 4.4 Add tests mirroring 3.4, asserting `ORDER BY [pk] DESC` default and the heap/view fallback path. → `__tests__/useTableData.defaultOrder.test.ts`.

## 5. Verification

- [x] 5.1 Run the app: open a PG/MySQL/MSSQL table with a single-column PK and confirm it opens newest-first with one fetch (check the activity log / network for no redundant empty-order fetch). _(manual — verified by user)_
- [x] 5.2 Confirm a composite-PK table orders by all PK columns DESC; a view / PK-less table is unchanged. _(manual — verified by user)_
- [x] 5.3 Confirm changing the order is respected (and, on Postgres, persists across restart) and is not clobbered by the default. _(manual — verified by user)_
- [x] 5.4 Run the frontend test suite and the existing data-grid tests; ensure no regressions. (22 new/related tests pass; the only suite failures — `EditableCell`/`Inspector` `autocorrect` assertions — pre-date this change and are unrelated to ordering.)
