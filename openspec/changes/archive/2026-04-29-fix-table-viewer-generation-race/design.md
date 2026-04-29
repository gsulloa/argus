## Context

The Postgres table viewer is implemented as a React hook (`useTableData`, in `src/modules/postgres/data/useTableData.ts`) that owns a small reducer-based state machine: `idle → loading-first → ready | error`, with a `generation` counter used as an in-flight cancellation token.

Two `useEffect`s coordinate the lifecycle:

```
Render N — state = { generation, status, ... }
   │
   ├─ Reset effect (line 188)        deps: [connId, schema, relation, pageSize, orderKey, filtersKey]
   │     dispatch({ type: "reset" })  // bumps generation, sets status: "idle"
   │
   └─ Trigger effect (line 258)      deps: [status.state, generation, fetchFirstPage]
         if (status === "idle") fetchFirstPage(closure_generation)
```

Both effects run after the same render commit and read the **same render snapshot**. On a fresh mount, that snapshot is `initialState() = { generation: 0, status: "idle" }`. The trigger effect sees `idle`, captures `generation = 0` from its closure, and calls `fetchFirstPage(0)`. The reset effect's `dispatch({reset})` is queued and processed afterward, bumping generation to 1 by the time the response arrives. The stale-response guard at line 209 then drops the only fetch:

```
if (stateRef.current.generation !== generation) return;
   //         1                          0  → returns silently → spinner stuck forever
```

The trigger effect cannot recover because its guard requires `status === "idle"`, but status is now `"loading-first"`. React StrictMode (enabled in `src/main.tsx`) makes this happen twice (mount A unmount, mount B), which is what shows up in the dev console as two `postgres_query_table` invokes both resolving but neither populating the grid.

The bug feels intermittent because it gets papered over by any subsequent re-render that re-fires the reset effect (e.g., `usePageSize` finishing its async load with a non-default value, or the user changing filters/sort/page-size manually).

The repo currently has zero test files (`find -name "*.test.*"` returns empty), so this regression slipped past review and has no existing harness to add coverage to.

## Goals / Non-Goals

**Goals:**

- Make the `loading-first → ready | error` transition deterministic on first mount, with no dependency on a side-effectful re-render.
- Keep the existing generation/cancellation semantics for legitimate races (rapid table-switch, filter changes mid-fetch).
- Establish frontend test infrastructure so this and future hook regressions are caught before merge.
- Add a regression test that fails today and passes after the fix, exercising the StrictMode mount/unmount/remount path.

**Non-Goals:**

- Replacing the generation token with `AbortController` (logged as a follow-up TODO; would require widening `dataApi.queryTable` to accept a signal and threading cancellation into the Tauri command).
- Aborting in-flight fetches on tab unmount (cosmetic; logged as TODO).
- Deduping StrictMode's double-fetch in dev (cosmetic; the activity log shows two entries in dev — out of scope for this fix).
- Auditing every other hook in the codebase for the same closure-stale pattern (good follow-up, not gating this PR).
- A broader test backfill across other modules. We add the infrastructure plus one targeted regression test; coverage expansion is a separate change.

## Decisions

### Decision 1: Lazy init plus a deps-fingerprint ref on the reset effect

Initialize `generation` to `1` directly in `initialState()` so the very first render's snapshot already reflects what the post-reset state would have been. Then make the reset effect idempotent under React 18 StrictMode's mount → cleanup → mount effect replay by comparing the current deps against a fingerprint stored in a ref. The effect only dispatches when the deps actually change.

```ts
function initialState(): State {
  return {
    rows: [],
    columns: [],
    status: { state: "idle" },
    queryMs: null,
    highestLoadedPage: 0,
    reachedEnd: false,
    generation: 1,        // ← pre-bumped: first fetch closure (1) matches stateRef (1)
    truncatedColumns: new Set(),
  };
}

// Reset buffer when paging inputs actually change. The fingerprint ref makes
// this effect idempotent under StrictMode's double-invoke; on first mount the
// ref is initialized to the current deps, so both the effect's body and its
// dev-only replay compare equal and return without dispatching.
const depsKey = `${connectionId}|${schema}|${relation}|${pageSize}|${orderKey}|${filtersKey}`;
const lastDepsKeyRef = useRef(depsKey);
useEffect(() => {
  if (lastDepsKeyRef.current === depsKey) return;
  lastDepsKeyRef.current = depsKey;
  dispatch({ type: "reset", pageSize });
}, [depsKey, pageSize]);
```

**Implementation note (deviation from original design):** The first draft of this design proposed a single-shot `useRef(true)` sentinel that skips the first run. That doesn't survive StrictMode's effect replay: React runs the effect, then runs cleanup, then runs the effect *again*. By the second run the sentinel is already `false`, so reset dispatches anyway, bumping `generation` past the closure value the trigger effect captured, which recreates the original bug. The regression test (rendered under `<React.StrictMode>`) caught this immediately during implementation. The fingerprint approach is the actual fix: it tests "did the deps really change?" instead of "is this the first call?", which is robust to any number of replays as long as the deps are stable strings.

**Why this over alternatives:**

- **(α) Lazy init + deps fingerprint ref** — chosen. ~10-line diff. The effect is genuinely idempotent: any number of replays with the same deps are no-ops; only an actual deps change dispatches. Explicit and minimal.
- **(α′) Lazy init + single-shot first-mount sentinel** — initial design. Rejected after implementation revealed it fails under StrictMode's effect replay (see note above).
- **(β) Single unified effect** — collapse reset and trigger into one effect keyed on `[connId, schema, relation, pageSize, orderKey, filtersKey]`, reading `stateRef.current.generation` after dispatch. Rejected: ~25-line diff, reorders responsibilities, and React does not synchronously update `stateRef.current` between a `dispatch` and the next line — you'd have to compute `nextGeneration = stateRef.current.generation + 1` locally, which couples the effect to the reducer's bump rule. More cleverness, less explicitness.
- **(γ) Read generation from a ref inside the trigger effect** — does not work in isolation, because at the time the effect runs `stateRef.current === state` (the same render snapshot the closure already captured). Would also require deferring the call into a microtask, adding asynchrony for no benefit.
- **(δ) Switch to TanStack Query / SWR** — out of scope. They sidestep this whole class of bug, but would require rewriting the buffered pagination, edit-buffer integration, and 57014 retry logic. Logged as a long-term consideration.

The fingerprint pattern is a standard idiom for making `useEffect` idempotent under StrictMode replays — it tests semantic equality of inputs rather than identity of run.

### Decision 2: Vitest + React Testing Library + jsdom

Stand up the standard Vite-native test stack rather than Jest:

- `vitest` — first-class Vite integration (this is a Vite project), no extra Babel/Jest config drift, native ESM, native TS.
- `@testing-library/react` — render hooks/components, exercise the real React reconciler.
- `@testing-library/jest-dom` — DOM matchers that read well in assertions.
- `jsdom` — DOM environment for the test runner.

`vitest.config.ts` reuses the existing `vite.config.ts` aliases (so `@/*` keeps working in tests). A `src/test/setup.ts` registers jest-dom matchers.

**Why this over alternatives:**

- **Jest** — would need separate config, separate alias resolver, and Babel for TS/JSX. The project uses Vite; Vitest is the path of least friction.
- **Playwright component tests / Cypress component tests** — too heavy for a hook regression test. We want to exercise the React state machine, not browser-level rendering.
- **Defer testing infrastructure** — rejected per the eng review: regression coverage is mandatory for a regression fix, and CC makes the marginal cost of standing up Vitest small (~30 min). "Well-tested code is non-negotiable" per project preferences.

### Decision 3: Test design — single regression test focused on the bug class

The regression test renders `useTableData` inside `<React.StrictMode>` with a mocked `dataApi.queryTable` that resolves synchronously with a known payload, then asserts:

1. `result.current.status` becomes `"ready"`.
2. `result.current.rows.length` matches the mocked row count.
3. The mock was called with the expected args at least once (StrictMode may fire twice — both is fine).

This is the smallest test that fails on `master` (with the bug) and passes after the patch. It does not aim for full hook coverage; that's deferred to a follow-up backfill.

`isTauriRuntime()` (line 14 of the hook) currently gates real fetches behind `window.__TAURI_INTERNALS__`. The test stubs `window.__TAURI_INTERNALS__` so the runtime check passes, then mocks `dataApi.queryTable` directly via `vi.mock("./api", ...)`.

## Risks / Trade-offs

- **Risk:** Pre-bumping `generation` to 1 in `initialState` couples initialization to the reducer's bump rule (which currently does `state.generation + 1`). If someone later changes the reducer to bump by something other than `+1`, the invariant breaks silently.
  - **Mitigation:** Inline comment on the `generation: 1` line documenting the invariant. Test asserts the loading→ready transition, which would catch any drift.

- **Risk:** The deps fingerprint string concatenates six values with `|`. If any value contained a literal `|` it would collide with the separator. In practice all six are either internal identifiers (`connectionId` is a UUID-like, `schema`/`relation` are quoted Postgres identifiers), numbers (`pageSize`), or `JSON.stringify` output (`orderKey`/`filtersKey`) — none of which collide meaningfully. A pathological collision would only cause a *missed* reset (false equality), which would be caught by the regression test if it affected the loading→ready transition.
  - **Mitigation:** Regression test under `<React.StrictMode>` exercises the common deps. If a collision case becomes plausible, switch to `JSON.stringify` of the full deps tuple.

- **Risk:** Standing up Vitest adds ~4 dev dependencies and one config file. Bundle size unaffected (dev-only).
  - **Mitigation:** None needed. Standard ecosystem choice.

- **Trade-off:** Not migrating to `AbortController` means in-flight fetches on stale generations still run to completion on the Rust side and get dropped on the JS side. For empty/small tables this is invisible; for very large tables it wastes Postgres work. Acceptable for now; logged as a follow-up.

- **Trade-off:** This change does not address the dev-only StrictMode noise in the activity log (two entries per table open in dev). Cosmetic; deliberately out of scope.

## Migration Plan

No migrations required. Single hook patch + new test infra.

Rollback is a `git revert`; no schema changes, no persisted state changes, no API contract changes.

## Open Questions

None blocking implementation. Logged TODOs (not part of this change):

1. Migrate generation token to `AbortController` so Rust queries can be cancelled when the JS side discards a stale response.
2. Abort in-flight fetches when the viewer tab unmounts.
3. Dedupe identical activity-log entries within a short window in dev (StrictMode cosmetic).
4. Audit `useTablePrimaryKey` and `useEditBuffer` for the same closure-stale-generation pattern.
