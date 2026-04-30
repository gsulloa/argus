## Context

`TabContent` (`src/platform/shell/tabs/TabContent.tsx`) renders the active tab via `<Renderer tab={active} />` with no `key` prop. When the active tab id changes between two tabs of the same `kind` (e.g. two `postgres-table-data` tabs), `TabRegistry.get(kind)` returns the same component reference, and React's reconciler reuses the existing `TableViewerTab` instance — only the `tab` prop changes. Hooks state is preserved.

`useSetting` (`src/platform/settings/useSetting.ts`) was written assuming key changes happen via mount/unmount, not via re-render of the same instance. Its `useState` initializer reads from the per-key memory cache *only on first mount*. The `[key]` effect re-runs the disk load, but in the common path (memory cache already has the new key, or no Tauri runtime, or no persisted value) the effect never calls `setValue` for the new key. The result: the hook returns the *previous* relation's `value` until a setter is called.

`useQueryBuffer` (`src/modules/postgres/sql/useQueryBuffer.ts`) writes `JSON.stringify("")` to its settings key in its unmount cleanup, with the comment "On close we drop." The intent is correct (closing a tab discards the buffer), but the cleanup also fires on React 18 StrictMode dev double-mount. Because the second mount's `getSetting` read may resolve *after* the cleanup's `setSetting` write, the second mount reads back `""` and overwrites the prefilled SQL passed via `payload.sql`. The result: `Open in SQL Editor` from the data viewer lands on a blank editor in dev.

## Goals / Non-Goals

**Goals:**
- Switching between two open `postgres-table-data` tabs of different `(connectionId, schema, relation)` triples MUST show each tab's own persisted filter / orderBy on first paint of the active tab. No bleed.
- `Open in SQL Editor` MUST land on an editor whose initial document is the SQL produced by `compilePrefilledSelect`, on every dev / prod mount path, including under `<React.StrictMode>` double-mount.
- The fix is surgical: `useSetting` and `useQueryBuffer` are the only files that change in behavior. `TabContent` and the per-tab components keep their current shape.

**Non-Goals:**
- Restructuring `TabContent` to add `key={active.id}` — it would solve bug 1 but reset all tab-local state (edit buffer, selected row, count) on tab switch, which the current design intentionally preserves.
- Refactoring `useSetting` into a Suspense / store-based primitive — the existing memory-cache + debounced disk lane is fine; only the key-change path is broken.
- Garbage-collecting persisted query buffers from closed Query tabs — separate change.
- Changing the wire shape of any backend command.

## Decisions

### D1: Re-derive `useSetting`'s `value` on key change, in render

**Decision:** Track the previous key in a `useRef`. On every render, if `key !== prevKeyRef.current`, synchronously call `setValue(memoryCache.get(key) ?? defaultValue)` and `setLoaded(memoryCache.has(key) || !isTauriRuntime())`, then update the ref. The existing `useEffect([key])` keeps its async load behavior unchanged.

```ts
const prevKeyRef = useRef(key);
if (prevKeyRef.current !== key) {
  prevKeyRef.current = key;
  const cached = memoryCache.get(key);
  setValue(cached === undefined ? defaultValue : (cached as T));
  setLoaded(memoryCache.has(key) || !isTauriRuntime());
}
```

**Rationale:** Calling `setState` during render is a documented React pattern when the new state is derived from props (here, `key`). React replays the render with the updated state before painting. This keeps `value` and `loaded` consistent with the new key on the same paint — no flash of stale data.

The fix lives in one place and benefits every consumer of `useSetting` (filter, orderBy, page size, theme, sidebar widths, …). Existing keyless callers are unaffected because `prevKeyRef.current` only changes when `key` actually changes.

**Alternatives considered:**
- *Add `key={tab.id}` on `<Renderer tab={active} />` in `TabContent`*: forces remount on tab switch. Solves bug 1 but resets all in-component state — including `useEditBuffer`, the selected row, the truncated-columns set, the count. The user has uncommitted edits; we don't want to lose them on tab switch.
- *Add `key={connectionId+schema+relation}` on the inner `<TableViewer>`*: scopes the remount to relation changes only. Cleaner than `tab.id`, but still resets the edit buffer when the same relation re-mounts at a different position. And it only addresses `TableViewer`; other consumers of `useSetting` retain the bug.
- *Effect-only fix (`setValue` inside the existing `useEffect([key])`)*: causes a flash of stale data on first paint after the key change, because the effect runs after render. Visible in the UI as the bar showing the old filter for one frame.

### D2: Drop `useQueryBuffer`'s unmount-time wipe; clear via the existing close-handler registry

**Decision:** Remove the `setSetting(key, JSON.stringify(""))` from `useQueryBuffer`'s unmount cleanup. Replace the "drop on close" semantic with a real tab-close hook: register a close-handler via the existing `registerCloseHandler` / `shouldCloseTab` registry that, when the tab actually closes, deletes the settings key (using `setSetting(key, "")` is fine — the buffer is no longer being read since the tab is gone).

Because `registerCloseHandler`'s contract is "intercept close — return true to allow", we can layer the cleanup either:
- Inside the close handler (run cleanup, return `true`), or
- In a sibling `afterClose` subscription if one is added.

Simpler path: the close handler runs the buffer cleanup synchronously and returns `true`. (Query tabs don't need a confirm dialog — closing a query tab is non-destructive by spec.)

The unmount cleanup MUST still flush in-flight write timers (so a debounced write doesn't fire after the component is gone) — that's separate from the buffer wipe and should stay.

**Rationale:** The unmount cleanup runs on:
1. Real tab close (intended)
2. StrictMode dev double-mount replay (NOT intended — wipes the buffer mid-mount)
3. Component-tree unmount for any other reason (parent re-render with different children, navigation, etc. — currently none of these happen for QueryTab, but the contract should not depend on that staying true)

Only #1 is a "real close". The close-handler registry already knows when #1 happens — `shouldCloseTab` is called exactly once, by `TabStrip`'s close button. Tying the buffer wipe to that signal makes the contract explicit and StrictMode-safe.

**Alternatives considered:**
- *Skip-first-cleanup ref*: `useRef(true)` flag that bails the first cleanup, then drops on subsequent ones. Brittle — relies on assumption that StrictMode runs exactly one extra cleanup, which may change across React versions. Also wrong in production where the first cleanup IS the real unmount.
- *Detect StrictMode at runtime*: no public API for it; `process.env.NODE_ENV === "development"` is unreliable (Tauri dev/prod splits don't always match Vite mode).
- *Write `latestRef.current` instead of `""` on unmount*: makes StrictMode replay safely re-write the prefilled SQL. But it leaks closed-tab buffers indefinitely (every closed tab leaves its last typed SQL on disk forever). Unbounded growth.
- *Keep the wipe but defer it via `setTimeout(0)` to "after StrictMode replay"*: timing-dependent and hides the underlying contract issue.

### D3: Preserve the existing assertion that `loaded` flips synchronously when memory cache has the key

`useSetting` already returns `loaded === true` synchronously when `memoryCache.has(key)` (hot path) or `!isTauriRuntime()` (jsdom tests). D1 must not regress that. The new render-time block sets `loaded = memoryCache.has(key) || !isTauriRuntime()` for the new key, which preserves the invariant.

This is what makes `useTableData`'s `enabled = filterLoaded && orderByLoaded` work correctly when switching to an already-cached relation: no extra "loading-first" frame, the fetch fires immediately.

## Risks / Trade-offs

- **Calling `setState` during render is unusual.** It's a supported pattern (React docs: "Storing information from previous renders") but reviewers may flag it. Mitigation: comment the block with a rationale and a link to the docs; gate strictly on `prevKeyRef.current !== key` so it can never loop.
- **Closed-buffer cleanup now depends on `shouldCloseTab` actually being invoked.** If a Query tab unmounts via a non-close-button path (parent unmount, app shutdown), the buffer leaks until the tab is re-opened with the same id (which is a one-time event since `genId()` is unique). Acceptable — same disk leak as page-size and inspector-width on closed sessions. Mitigation: a follow-up "GC closed-tab buffers on app start" is cheap.
- **`useSetting` consumers that pass an unstable `key` (e.g. computed each render) will now thrash setState during render.** None of the current consumers do this; all pass derived strings from stable props. Mitigation: keep the existing convention; document the requirement on the hook.
- **Adding a close-handler in `useQueryBuffer` collides with `useCloseConfirm` if a future feature wants to gate close on a dirty Query buffer.** The registry is a single-handler-per-tab map. Mitigation: `useQueryBuffer`'s handler can be composed with `useCloseConfirm`'s handler — or, cleaner, the registry can be extended to support multiple handlers. Out of scope for this fix; the simple path is fine for now.

## Migration Plan

UI-state bug fix only. No wire-format changes, no schema changes, nothing for the user to migrate. After the fix, `useSetting` consumers see the correct value for the current key on first paint, and `Open in SQL Editor` lands on the prefilled editor in dev and prod.

Rollback: `git revert`.

## Open Questions

- Should the close-handler registry support multiple subscribers per tab so a future "confirm dirty buffer" handler can compose with the buffer-cleanup handler? Likely yes, but out of scope here. Tracked separately.
- After this fix, do we still need the `enabled = filterLoaded && orderByLoaded` gate in `useTableData`? Yes — D3 preserves the synchronous-`loaded`-when-cached invariant, and the gate is still required for the cold-path Tauri disk read on first-ever open. No change.
