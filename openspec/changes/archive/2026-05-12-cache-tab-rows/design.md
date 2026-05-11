## Context

The Argus tab shell at `src/platform/shell/tabs/TabContent.tsx` renders only the **active** tab. Inactive tabs unmount entirely. The table viewer's rows live inside `useTableData`'s reducer (`src/modules/postgres/data/useTableData.ts:296-300`), the selected row index lives in `TableViewerTab` state (line 191-193), the edit buffer is per-component (line 336), and the scroll position belongs to the virtualized grid's DOM node. All of this disappears the moment another tab is activated, and the fetch effect at `useTableData.ts:296` re-fires on the next activation because the component remounts in `idle` state.

There is **no row cache** today. The only cache that survives unmount is `globalSchemaCache` (column metadata). State management is React Hooks + Context — no Zustand/Redux/React Query.

Tabs are bounded in practice (the user opens a handful at a time). The data grid is already virtualized (`postgres-data-grid` spec), so the DOM footprint of an inactive table tab is small even if it stays mounted.

## Goals / Non-Goals

**Goals:**
- Switching away from a tab and back is instant: same rows, same scroll, same selection, same edit buffer, **zero refetch IPC**.
- Refetch happens only when (a) a query input changes (filter/orderBy/pageSize), (b) the user explicitly refreshes, or (c) the tab is opened for the first time.
- The change must be transparent — no new user-facing UI, no settings, no behavior change beyond eliminating the refetch.
- Closing a tab releases its retained state immediately (no memory leak).

**Non-Goals:**
- No cross-tab cache sharing. Two tabs open on the same `(conn, schema, relation)` are independent.
- No persistent (on-disk) row cache. Closing a tab discards rows; reopening fetches fresh.
- No TTL / staleness detection / background revalidation. If the user wants fresh data after an external change, they refresh explicitly.
- No new dependency (React Query, SWR, Zustand, etc.).
- SQL editor result caching follows the same model but is otherwise out of scope here beyond mirroring the pattern.

## Decisions

### Decision 1: Keep all tabs mounted; toggle visibility via CSS — DO NOT use an external row cache

**Chosen:** Render every open tab simultaneously inside `TabContent`. The active tab is visible; inactive tabs have `display: none` (or equivalent). Each tab's component tree, its `useTableData` hook, its reducer state, and the DOM of its virtualized grid all persist across activations.

**Why:**
- Zero changes to `useTableData`, `TableViewerTab`, `QueryTab`, or any downstream hook. The fetch effect simply never re-runs because the component never unmounts.
- Scroll position is automatically preserved by the live DOM node — no manual save/restore.
- Edit buffer, selected row, sub-tab (Data/Structure/Raw), inspector width — all preserved with no per-feature plumbing.
- No cache invalidation logic, no stale-data bugs, no serialization concerns.

**Alternatives considered:**

- **External cache keyed by `tabId` (Map in a singleton or context).** `useTableData` would read initial state from the cache on mount and write updates back. Pros: lower memory ceiling (only data, not DOM). Cons: requires invasive changes to every stateful hook in every tab kind (`useTableData`, edit buffer, selection, scroll), introduces cache-vs-source-of-truth bugs, and would need to track scroll manually. Rejected — much more complexity for a marginal memory win given virtualization.
- **React Query / TanStack Query.** Solves caching cleanly but introduces a substantial dependency and refactor surface, and conflicts with the existing reducer-based `useTableData`. Rejected for v1 — can be revisited if we need cross-tab dedup or background refresh.
- **Persistent SQLite/IndexedDB cache.** Adds a settings boundary, requires invalidation on writes, and exceeds the scope of "no refetch on tab switch." Rejected.

### Decision 2: Pass an `active: boolean` prop to every tab renderer

The tab renderer signature changes from `Renderer({ tab })` to `Renderer({ tab, active })`. Renderers MUST gate any **window-level / document-level** side-effects (keyboard listeners, focus traps, command-palette hooks, document title updates) on `active === true`. In-component effects (data fetching, internal state) need no changes.

**Why:** with all tabs mounted, two `keydown` listeners registered at `window` would both fire on every keypress. Most Argus shortcuts are routed through the central shortcut layer (`src/platform/shell/keymap/*`), but any per-tab `window.addEventListener` must be audited and gated.

**Implementation rule:** renderers that currently register a window listener inside `useEffect` either (a) move it behind `if (!active) return;` inside the effect with `active` in the dep array, or (b) attach to the tab's own DOM container instead of `window`.

### Decision 3: Hide via `display: none`, not `visibility: hidden` or off-screen positioning

`display: none` collapses layout, prevents painting, and removes the subtree from the focus order. The virtualized grid's `ResizeObserver` will fire with zero dimensions when hidden and again when shown — implementations must handle that gracefully (most virtualization libs already do; verify in the QA pass).

**Alternatives considered:** `visibility: hidden` keeps the layout cost; `position: absolute; left: -99999px` keeps layout *and* breaks focus management. Rejected.

### Decision 4: Initial mount is lazy ("mount on first activation")

A tab is added to the DOM only **after** the user first activates it. Subsequent deactivation/activation does not unmount. This avoids paying the fetch cost for tabs the user opens in bulk (e.g., via quick-switcher) and never visits.

**Implementation:** `TabContent` tracks a `Set<string>` of tab IDs that have ever been active. On every render, it includes a `<TabRendererSlot>` for each tab in that set; the active slot is visible, the rest are hidden. The set is updated in an effect when `activeTabId` changes.

### Decision 5: Closing a tab unmounts and releases memory

`TabsContext.close(id)` already removes the tab from `tabs[]`. `TabContent` MUST drop it from the "ever-activated" set on close so the renderer unmounts. This is the only path that frees rows/edit-buffer memory.

### Decision 6: SQL editor result is held by the same mechanism

`QueryTab` already keeps its last result in component state (`src/modules/postgres/sql/useQueryRun.ts`). With all tabs mounted, that state is automatically retained across activations. No code changes inside `QueryTab` itself — only the shell change in Decision 1 is required.

### Decision 7: No spec-level change to `postgres-data-grid` fetch semantics

The data-grid spec already says fetch is triggered by `enabled` + reducer-`idle` transitions, and reset is triggered by changes in `connectionId | schema | relation | pageSize | orderBy | filters`. We are NOT changing those rules. We ARE adding a new requirement that tab activation is not a remount, which means activation does not move the reducer through `idle` again.

## Risks / Trade-offs

- **Memory growth with many open tabs.** Each table tab holds its `pageSize` rows (typically 200–500) in memory plus the live DOM of a virtualized grid (~tens of rows worth of nodes). For 20 tabs at 500 rows × ~1 KB per row that is ~10 MB. → **Mitigation:** acceptable for v1; monitor and revisit (Decision 1 alternative) if users routinely open > 50 tabs.

- **Hidden tabs still run effects and timers.** A tab kind with polling or a long-lived subscription would keep running in the background. → **Mitigation:** audit existing tab kinds (table viewer, SQL editor, activity log, query history, table structure, raw) for `setInterval`, `addEventListener`, and Tauri event subscriptions; gate by `active` where appropriate. None of these tab kinds polls today, but the audit is a task.

- **Two tab kinds registering window keyboard listeners would double-fire.** → **Mitigation:** Decision 2 forces `active`-gating; the QA pass MUST exercise common shortcuts (filter focus, save, refresh) with multiple table tabs open.

- **Virtualized grid resize quirks when hidden.** A `ResizeObserver` on a `display:none` element fires with `0×0`. The grid component must not interpret this as "scroll to top" or "reset selection." → **Mitigation:** verify in QA; if a regression appears, gate the grid's resize handler by `active`.

- **In-flight fetch when user switches tabs mid-load.** Today this is fine because the abort token is `state.generation` and the response is dropped on remount. With keep-mounted, the fetch completes and populates the now-hidden tab. → That's actually the desired behavior (data ready when the user returns) — keep as-is.

- **Tab cycling via keyboard becomes faster than first-mount.** When a user first activates a tab, mounting + fetch can briefly block the UI. → **Mitigation:** mount is already cheap; the fetch is async. Acceptable.

## Migration Plan

This is an internal UI behavior change with no data migration, no IPC schema change, and no settings change.

1. Implement `TabContent` keep-mounted rendering with `active` prop.
2. Audit and gate window-level listeners in every registered tab renderer.
3. Manual QA: open ≥ 5 table tabs, switch between them, verify zero `query_table` events in activity log on activation, verify scroll/selection/edit buffer preserved.
4. Ship behind no flag — pure behavior fix.
5. **Rollback:** revert the `TabContent` change; everything else (renderer `active` prop) is backward compatible because old behavior was effectively `active=true` for the one mounted tab.

## Open Questions

- Do any existing tab renderers register window keyboard listeners that we will need to gate? (Answer in implementation phase via grep over `addEventListener("keydown"`.)
- Does the virtualized grid handle `display:none` cleanly, or do we need a `key={...}` bump on re-show? (Answer in QA phase.)
- Should we eventually expose a "Refresh" affordance per tab to refetch on demand, now that auto-refetch is gone? (Out of scope for this change; the existing filter "Apply" already forces a refetch, and the user can close + reopen.)
