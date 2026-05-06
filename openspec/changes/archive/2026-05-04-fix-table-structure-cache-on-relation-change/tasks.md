## 1. Reset cache on triple change

- [x] 1.1 In `src/modules/postgres/structure/useTableStructureCache.ts`, compute `key = ${connectionId}|${schema}|${relation}` once per render.
- [x] 1.2 Initialize `lastKeyRef = useRef(key)` so the first render's compare is a no-op (matches `useTableData`'s pattern).
- [x] 1.3 Add a render-phase compare: if `lastKeyRef.current !== key`, set `lastKeyRef.current = key`, call `setState({ status: "idle", response: null, error: null })`, set `inflightRef.current = null`, and bump `generationRef.current`.
- [x] 1.4 Add `generationRef = useRef(0)`. Capture `const gen = generationRef.current` at the start of `dispatch`. Before each `setState` in `dispatch`'s success and error branches, check `if (generationRef.current !== gen) return;` so a late response from the previous triple is dropped.
- [x] 1.5 Replace the misleading multi-line comment that asserts the component re-mounts per relation with a one-line note that the cache is keyed on `(connectionId, schema, relation)` and resets in render when the key changes.

## 2. Tests

- [x] 2.1 Add a vitest case to `src/modules/postgres/structure/useTableStructureCache.test.ts`: render with `("c1", "public", "A")`, drive `ensureLoaded` to `ready` with a stub response, rerender the same hook with `("c1", "public", "B")`, assert `state.status === "idle"` and `state.response === null` immediately on the next read.
- [x] 2.2 Add a vitest case for the late-response drop: render with `("c1", "public", "A")`, start `ensureLoaded` against a controllable promise, rerender with `("c1", "public", "B")` *before* the A promise resolves, then resolve the A promise — assert `state.response === null` (or whatever B's eventual response is) and the A response is never written.
- [x] 2.3 Run `pnpm test:run` and confirm all existing structure-cache tests still pass.

## 3. Verification

- [x] 3.1 `pnpm typecheck` — pass.
- [x] 3.2 `pnpm lint` — no new errors (existing warning count unchanged).
- [x] 3.3 Manual QA against a live Postgres connection: open table A, click **Structure**, wait for it to load, switch to table B's tab (must already be open), click **Structure** → confirmed table B's columns / DDL are shown, not table A's.
- [x] 3.4 Manual QA for the in-flight case (covered by the unit test for late-response drop and confirmed by user during live QA).
- [x] 3.5 Manual QA for the cache-hit case (the `state.status === "ready"` short-circuit in `ensureLoaded` is exercised by the existing dedup test and confirmed by user during live QA).

## 4. OpenSpec hygiene

- [x] 4.1 `openspec validate fix-table-structure-cache-on-relation-change --strict` — passes.
- [x] 4.2 Archive this change AFTER `table-structure-tab` archives (so `postgres-table-structure/spec.md` exists in `openspec/specs/` to receive the MODIFIED requirement). `table-structure-tab` archived as `2026-05-04-table-structure-tab`.
