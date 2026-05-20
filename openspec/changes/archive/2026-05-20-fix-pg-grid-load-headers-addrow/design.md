## Context

The Postgres table viewer (`TableViewerTab` → `useTableData` → `DataGrid`) has three observed defects, surfaced during dogfooding:

1. **Stuck first-load spinner.** On cold mounts where the per-relation persisted settings (`pgTableFilter:*`, `pgTableOrderBy:*`, `pgTableFilterBarVisible:*`, `pgPageSize:*`) have not yet been cached in memory, the disk reads resolve asynchronously and update React state after `TableViewerTab` is already mounted. `useTableData` uses a `state.generation` counter as a cancellation token for in-flight fetches. When the post-disk-load reset bumps the generation in the same render that the fetch effect kicks off, the fetch captures the *old* generation (`gen=1`) while reading the *new* params from refs and dispatching `first-loading`. By the time the (correct) response arrives, `stateRef.current.generation` has been incremented to `2` and the response is silently discarded — but no new fetch is ever fired, because the queued `reset` was overwritten by the queued `first-loading` dispatch when React processed the batch. The viewer sits in `loading-first` forever even though the backend already returned. This violates the existing requirement "Deterministic first-page load on viewer mount" in `postgres-data-grid`.

2. **Truncated column headers.** Each header cell stacks `colName (flex:1, ellipsis) | sortBadge? | colType | ResizeHandle` inside a width drawn from `BASE_WIDTH_BY_CATEGORY` (e.g. `text: 200`, `numeric: 120`). The `colType` chip is small but constant (~60–80px), so any non-trivial column name on a `text` or `numeric` column gets ellipsis-truncated by default even when the cell values render fully. Users do not see "what column am I looking at" without resizing every column manually.

3. **Add row not visible.** `TableViewerTab.onAddRow` calls `buffer.addInsertRow({})` and `setSelection({ anchor: 0, active: 0 })` but does not scroll the virtualized viewport. If the user is scrolled mid-table, the new row appears at index 0 (off-screen) with no visual confirmation that anything happened.

Constraints:
- No backend / Tauri command changes.
- No persisted-data format changes.
- Must not regress existing behavior covered by `postgres-data-grid` spec scenarios (StrictMode mount/unmount, in-flight cancellation on real param changes, persisted column-width overrides, etc.).
- Must comply with `DESIGN.md` aesthetic (monochrome, hairline borders, Geist Mono headers).

## Goals / Non-Goals

**Goals:**
- Cold-mount viewer always transitions out of `loading-first` to `ready` or `error` once the backend resolves. No silent discards under normal disk-load race.
- Column headers display the column name fully at default widths for any reasonable name length (~24 chars on a `text` column).
- Clicking "Add row" results in the newly inserted row being visible without further user action.

**Non-Goals:**
- Generalizing the fix to the Dynamo data view or to `AdhocResultGrid`. Those grids have their own load lifecycles and do not exhibit the bug; we leave them alone.
- Reworking the cancellation-token system for `loadNextPage` (the bug is in the first-page path; the next-page generation check is fine because next-page fetches do not run during reset).
- Auto-fitting columns to the *widest cell value* (only headers). Cell content auto-fit is a heavier feature and out of scope.
- Adding a visible type indicator elsewhere in the grid. The Structure subtab already lists every column with its full type, and the header `title` tooltip still shows `<name> : <data_type>`.
- Changing column-width persistence. Existing `pgColumnWidths:*` records keep applying as-is.

## Decisions

### D1 — Replace `state.generation` with a render-synchronous depsKey ref

**Decision:** Drop the `generation: number` field from the reducer. Add a `useRef<string>` (call it `paramsKeyRef`) updated *during render* (the same way `pageSizeRef.current = pageSize`) to hold the latest `depsKey` (composite of `connectionId|schema|relation|pageSize|orderKey|filtersKey`). The fetch callback captures the depsKey value at call time; after each `await`, it compares `paramsKeyRef.current` against the captured value. Stale responses are discarded; non-stale ones are applied.

**Rationale:**
- The root cause is that the generation token lives in the reducer (advanced via dispatch in an effect) while the params themselves live in refs (advanced during render). The two clocks fall out of phase under React 18's batched dispatch. Putting both clocks in render-phase refs removes the skew entirely.
- The depsKey *is* the canonical identity of "which fetch this is" — it is already computed for the reset effect's guard. Reusing it eliminates a redundant id.

**Alternatives considered:**
- *A. Keep generation, also re-fire fetch on discarded response.* Adds a corrective path but does not fix the root cause; future re-architecting may re-introduce the bug.
- *B. Use `useTransition` or React's `useSyncExternalStore` to coordinate.* Heavier refactor; the dataflow is otherwise simple.
- *C. Coalesce all `useSetting` reads into one effect that resolves before the first render.* Would require either lifting state up or suspense; out of proportion for this bug.

### D2 — Drop the inline `colType` chip from the header and rely on tooltip + Structure subtab

**Decision:** Remove the `<span class={styles.colType}>{col.data_type}</span>` rendering from `DataGrid.tsx`. Keep the existing `title={`${col.name} : ${col.data_type}`}` on the header cell so the type is still discoverable by hover, and the Structure subtab continues to be authoritative for type/nullability/defaults.

**Rationale:**
- The type chip costs more screen real estate than it pays for. Most users glance at the header to identify the column, not its SQL type. Power users opening Structure get the full type plus modifiers (`varchar(255)`, `numeric(10,2)`) that the chip already truncates anyway.
- Matches the TablePlus/DBeaver convention (name primary; type secondary via hover or schema browser).
- Aligns with `DESIGN.md`'s "no decorative noise" stance — the chip was effectively decorative.

**Alternatives considered:**
- *A. Two-line header (name above, type below).* Doubles header height; conflicts with the compact density `DESIGN.md` calls for. Would also require all consumers of `HEADER_HEIGHT` (sticky offsets, drag math) to update.
- *B. Show the type only on hover.* Adds JS state + visual flicker; tooltip already covers this.
- *C. Keep the chip; just widen defaults.* Widening defaults makes every grid horizontally scroll sooner, which is worse for narrow displays.

### D3 — One-shot header auto-fit at first render

**Decision:** Add a `measureHeaderWidth(name: string): number` helper that uses an off-DOM `<canvas>` with the same `font-family` / `font-size` as the header to compute the text's pixel width, plus a fixed pad for header padding (`12px * 2`), gap (`4px`), sort badge slot, resize-handle slot, and key-badge slot. In `useColumnWidths`, when there is no user override AND no fixed width, return `Math.max(typeBaseWidth, measuredHeaderWidth)` instead of just `typeBaseWidth`.

The measurement is memoized per `(name, isKey)` tuple. It runs lazily on first read inside `widthFor`. Resizing or double-click-reset behavior is unchanged: a user override still wins; double-click still clears to the *new* effective base (which now includes the header floor).

**Rationale:**
- Auto-fitting on header text is cheap (canvas measure of a short string), deterministic, and works fully offline.
- Combining with the type-derived base via `Math.max` preserves the "predictable, type-aware default" we already have (a uuid column stays at 280px even if its name is `id`).
- It naturally fixes the bug ONLY when the user has not customized the column — i.e., it never overrides a deliberate user choice.

**Alternatives considered:**
- *A. Measure on every render via `getBoundingClientRect` after layout.* Forces sync layout; bad for 50+ column tables.
- *B. Hard-code wider defaults for `text`/`other`.* Inflexible: still truncates a 28-char column name.
- *C. Persist auto-fit results to disk as if they were overrides.* Confuses "user override" with "auto-fit", muddying the existing reset behavior.

### D4 — `forwardRef` on `DataGrid` exposing `scrollToTop()`

**Decision:** Convert `DataGrid` from a plain `function` component to `forwardRef`, and expose an imperative handle via `useImperativeHandle`:

```ts
interface DataGridHandle {
  scrollToTop(): void;
}
```

The implementation calls `virtualizer.scrollToIndex(0, { align: "start" })` if the virtualizer is initialized, falling back to `viewportRef.current?.scrollTo({ top: 0 })`. `TableViewerTab` holds a `gridRef` and calls `gridRef.current?.scrollToTop()` after `buffer.addInsertRow({})`.

**Rationale:**
- Imperative API matches the use case (one-off side effect from a parent gesture). Lifting "should scroll" into state would require an effect plus a flag and reset; ref is one line.
- `forwardRef` is already an accepted pattern in this codebase (FilterBar uses it for `FilterBarHandle`).

**Alternatives considered:**
- *A. Pass a "scroll signal" prop (incrementing counter) that DataGrid watches in an effect.* Works but adds re-render churn and a stale-closure footgun.
- *B. Move the viewport ref up to `TableViewerTab`.* Leaks DOM ownership across components; worse separation.

### D5 — Test the cold-mount race directly

**Decision:** Add a focused unit test in `useTableData.test.ts` (new file) that:
- Mocks `useSetting` so the filter resolves *after* the orderBy AND in a fresh microtask (mimicking the cold-disk-load order).
- Mocks `dataApi.queryTable` to resolve with a deterministic payload after one microtask.
- Asserts that `status` reaches `"ready"` and `rows.length > 0` within `await flushPromises()` cycles, regardless of which order the settings hooks resolve in.

**Rationale:** Without a regression test, this race is one refactor away from coming back. The test should fail against `master` and pass after D1.

## Risks / Trade-offs

- **Risk: D1 changes the cancellation behavior in subtle ways** → Mitigation: keep the next-page (`fetchNextPage`) generation logic unchanged; only the first-page path uses the depsKey token. Add the cold-mount regression test plus an explicit test for "params change mid-flight; the stale response is discarded".

- **Risk: D2 hides type information from users who relied on the inline chip** → Mitigation: the `title` tooltip on the header cell already exposes `name : data_type`. The Structure subtab is the authoritative type view. We will mention the change in the relevant scenario block of the spec so design-review can call it out.

- **Risk: D3's canvas measurement reads a stale font on first paint** → Mitigation: read `getComputedStyle(document.body).fontFamily` and `font-size` from a sample header cell once per mount (or use a hardcoded `11px Geist Mono` matching the CSS). The font tokens are stable per `DESIGN.md`.

- **Risk: D4 breaks DataGrid's existing JSX usages** → Mitigation: `forwardRef` is backwards-compatible — callers that pass no ref are unaffected. The viewer is the only caller today.

## Migration Plan

No runtime migration needed. The change is a single PR:
1. Land the `useTableData` refactor + race test.
2. Land the `DataGrid` header cleanup + auto-fit helper + tests.
3. Land the `forwardRef` + `onAddRow` scroll call + test.
4. Update specs (`postgres-data-grid` delta).

Rollback is a single git revert; no data on disk is touched.

## Open Questions

- Should `AdhocResultGrid` (read-only SQL results) get the same header treatment? — Out of scope for this change. We can revisit when the next ad-hoc UX pass happens.
- Should "Add row" also focus the first editable cell of the new row in addition to scrolling? — Already the existing behavior on Dynamo's `InsertModal`; here it would be a small follow-up. Not blocking this change.
