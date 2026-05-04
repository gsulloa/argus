## Context

`useTableStructureCache(connectionId, schema, relation)` is mounted once per `TableViewer` and feeds both the Structure and Raw subtabs. It owns three values: a `useState` of `{ status, response, error }` and a `useRef` of the in-flight promise.

`TabContent` renders the active tab as `<Renderer tab={active} />` with no `key`. When the user switches between two `postgres-table-data` tabs, React reconciles the same `TableViewerTab` component instance and only the `tab` prop changes. All `useState`/`useRef` values inside `TableViewer` survive the swap unless a hook explicitly handles arg changes.

`fix-stale-tab-state` (2026-04-30) already audited the per-tab hooks for this exact bug class and fixed `useSetting` (which underpins filter / sort / page-size). The structure cache was added later in `table-structure-tab` and inherited the broken assumption directly — its inline comment even claims, incorrectly, that the component re-mounts per relation.

`useTableData` solves the same problem with a `depsKey` ref: it computes a key from props, compares against `lastDepsKeyRef`, and dispatches `reset` on change. That pattern is the right shape for this fix.

## Goals / Non-Goals

**Goals:**

- The Structure / Raw subtabs of table B never display table A's response, even when the user has previously loaded Structure on table A in another open tab.
- A slow `postgres_table_structure` response keyed to table A MUST NOT land in table B's cache after the user switches tabs mid-fetch.
- Existing per-tab caches (Data subtab's row buffer, edit buffer, scroll position) keep working — the fix is local to `useTableStructureCache`.

**Non-Goals:**

- Refactoring `TabContent` to mount a fresh tree per tab (would reset state we want to keep).
- Adding a global structure cache shared across tabs of the same relation (the current per-tab semantics are correct; two open tabs of `public.users` SHOULD have independent caches per the existing requirement).
- Cancelling the in-flight Postgres backend on the server side when the user switches tabs (the fetch will complete and be discarded; cancelling is a separate optimization).

## Decisions

### Decision: Detect arg change with a `useRef`, reset state during render

**Approach:** mirror `useTableData`'s `depsKey` pattern. Compute `key = ${connectionId}|${schema}|${relation}`, compare to `lastKeyRef.current` during render, and if they differ, set `lastKeyRef.current = key` and call `setState(initialState)` synchronously. React batches this — the next render commits with the reset state.

**Why over alternatives:**

- *Detect in `useEffect`*: produces a one-frame flash of the previous tab's data before the effect runs — exactly the "no stale frame" guarantee we want to keep.
- *`useMemo` keyed on `key`*: doesn't actually reset the underlying `useState`; would require switching the cache to a `useRef` + `useReducer` shape and rewriting both subtabs.
- *`key` prop on `TableViewer`*: see Non-Goals — wipes all sibling state.

### Decision: Bump a generation counter; drop late responses

**Approach:** add `generationRef = useRef(0)`. Bump it inside the same arg-change branch above. Every `dispatch` call captures the generation at start; before applying the response with `setState`, it checks `generationRef.current === captured`. If not, return without dispatching the result. The in-flight promise from the previous triple is allowed to finish — we just discard its `setState`.

**Why:** simpler than `AbortController` (the underlying `schemaApi.tableStructure` is a Tauri command without an obvious cancel path), and consistent with `useTableData`'s `generation` mechanism. Costs one extra catalog-query roundtrip in the worst case, which is acceptable.

**Edge case:** the first render has `lastKeyRef.current === undefined`. Initialize `lastKeyRef` to the current key on first render so the reset branch doesn't fire spuriously on mount (matching `useTableData`'s pattern exactly).

### Decision: Also clear `inflightRef` on reset

**Why:** if a fetch was in flight against the old triple, `inflightRef.current` points to that promise. A subsequent `ensureLoaded` call on the new triple short-circuits because `inflightRef.current` is non-null and returns the old promise — which resolves into a discarded `setState` (good) but leaves the new triple stuck in `loading` indefinitely (bad). Setting `inflightRef.current = null` in the reset branch forces `ensureLoaded` to dispatch a new fetch.

### Decision: Don't change the public API of the hook

**Why:** both `StructureSubtab` and `RawSubtab` already call `cache.ensureLoaded("user")` from a `useEffect` keyed on `cache`. They will see `state.status === "idle"` after the reset and re-trigger the fetch automatically. No changes needed in either subtab.

## Risks / Trade-offs

- **[Risk]** A late response from triple A lands while React is still mid-commit on triple B → late `setState` is dropped (generation check fires). **Mitigation:** generation comparison happens at the call site of `setState`, not via React state, so it's deterministic regardless of render timing.
- **[Risk]** Two rapid arg changes (A → B → A within the same tick) cause two resets and two pending dispatches. **Mitigation:** generation counter increments monotonically; only the most recent dispatch's response is accepted. Worst case is two extra catalog-query calls; outcome is still correct.
- **[Trade-off]** We don't cancel the abandoned Postgres backend. Each abandoned fetch holds a connection from the pool for up to 10s (the outer timeout). For a user mashing tabs, this could pile up — but the Postgres pool already serializes; the server bears the cost, not the UI.

## Migration Plan

Single PR. No data migration. The fix is observable via the existing `useTableStructureCache.test.ts` (will gain one new case) and manual: open two tables, hit Structure on the first, switch to the second, click Structure → should now show the second table's DDL.

## Open Questions

_(none — the fix mirrors an established pattern in `useTableData`.)_
