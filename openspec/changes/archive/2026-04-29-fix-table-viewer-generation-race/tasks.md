## 1. Test infrastructure

- [x] 1.1 Add dev dependencies: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`
- [x] 1.2 Create `vitest.config.ts` at the repo root with `environment: "jsdom"`, `globals: true`, `setupFiles: ["./src/test/setup.ts"]`, and the `@/*` alias mirrored from `vite.config.ts`
- [x] 1.3 Create `src/test/setup.ts` that imports `@testing-library/jest-dom`
- [x] 1.4 Add `"test": "vitest"` and `"test:run": "vitest run"` scripts to `package.json`
- [x] 1.5 Update `tsconfig.json` (or add `tsconfig.test.json`) so test files type-check with `vitest/globals` and jest-dom matchers — chose explicit imports in test files instead; jest-dom matchers' type augmentation propagates through `src/test/setup.ts`. No tsconfig change needed.
- [x] 1.6 Verify `pnpm test:run` exits 0 with "no tests found" before any tests are added — vitest 4 exits with code 1 on "No test files found"; config loads fine and the include glob is correct. Will be verified end-to-end in 3.9.

## 2. Patch `useTableData` to fix the generation race

- [x] 2.1 In `src/modules/postgres/data/useTableData.ts`, change `initialState()` so `generation: 1` (matches the post-reset value)
- [x] 2.2 Update the JSDoc on the `generation` field (around line 40-41) to document the invariant: "Initial value is 1 so the first-mount fetch's closure matches `stateRef`. Reset bumps on every subsequent dep change."
- [x] 2.3 Add a `const isFirstMount = useRef(true);` ref above the reset effect — superseded during implementation: a single-shot sentinel doesn't survive StrictMode's mount → cleanup → mount effect replay (the second run flips the ref to `false` and dispatches reset, recreating the bug). Replaced with a deps-fingerprint ref (`lastDepsKeyRef`) that compares the current deps against the last seen key, making the effect idempotent under StrictMode's double-invoke.
- [x] 2.4 Modify the reset effect (currently at line 188) to skip its first run when `isFirstMount.current === true`, then flip it to `false` — superseded as above. Implementation: effect now compares `depsKey` (a stable string of all deps) against `lastDepsKeyRef.current` and only dispatches when they differ; the ref is initialized to the current `depsKey` on first render so the initial run and its StrictMode replay are both no-ops.
- [x] 2.5 Confirm no other call sites depend on `generation` starting at 0 (search the file) — also audited `useSchemaTree.ts` (the only other hook with a `generation` field): uses a per-mount `cancelled` ref instead of generation comparison, so not affected by the same race.

## 3. Regression test

- [x] 3.1 Create `src/modules/postgres/data/useTableData.test.tsx`
- [x] 3.2 In the test, stub `window.__TAURI_INTERNALS__` so `isTauriRuntime()` returns true
- [x] 3.3 Mock `./api` so `dataApi.queryTable` returns a resolved `QueryTableResult` with N>0 rows and matching columns
- [x] 3.4 Mock `../schema/globalSchemaCache` so `recordColumns` is a no-op
- [x] 3.5 Render the hook with `renderHook` from `@testing-library/react`, wrapping the hook tree in `<React.StrictMode>`
- [x] 3.6 Assert that, after promises flush, `result.current.status === "ready"` and `result.current.rows.length === N`
- [x] 3.7 Add a second test case covering the empty-table path (mock returns 0 rows; assert status reaches `"ready"` and rows is `[]`)
- [x] 3.8 Add a third test case covering the error path (mock rejects with an `AppError`; assert status reaches `"error"` and `result.current.error` is non-null)
- [x] 3.9 Verify all three tests pass with the patch applied AND fail (at least the first one) when the patch is reverted on a scratch branch — verified in-place: 3/3 fail when the fingerprint guard is reverted; 3/3 pass with the fix applied.

## 4. Manual QA

- [ ] 4.1 Run `pnpm tauri dev` and open a Postgres connection
- [ ] 4.2 Click an empty table; confirm the grid shows the empty state immediately (no stuck spinner) and the activity log shows the query completion
- [ ] 4.3 Click a non-empty table; confirm rows render and the activity log shows the row count
- [ ] 4.4 Open DevTools and verify `[argus.data] invoke ←` appears for both `postgres_query_table` and `postgres_table_primary_key` and the spinner clears
- [ ] 4.5 Switch between several tables in quick succession; confirm no stale data flashes and the final selected table renders correctly
- [ ] 4.6 Change `pageSize` from the bottom bar; confirm the grid resets and reloads cleanly
- [ ] 4.7 Apply a column filter and clear it; confirm clean transitions in both directions

## 5. Validate spec delta

- [x] 5.1 Run `openspec validate fix-table-viewer-generation-race` and resolve any errors — passes ("Change 'fix-table-viewer-generation-race' is valid").
- [x] 5.2 Run `openspec diff fix-table-viewer-generation-race` and confirm the spec delta reads as intended — `diff` subcommand doesn't exist in openspec 1.2.0; used `openspec show fix-table-viewer-generation-race` instead, which renders the proposal/spec content cleanly. Spec delta reads as intended.
