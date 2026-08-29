## 1. Test environment

- [x] 1.1 In `packages/app/src/test/setup.ts`, add a guarded `ResizeObserver` stub
  (class with no-op `observe` / `unobserve` / `disconnect`) assigned to `globalThis`
  only when absent. This is the first `ResizeObserver` use in the app.
- [x] 1.2 In the same file, add a guarded `Element.prototype.scrollIntoView = () => {}`
  fallback (jsdom does not implement it).
- [x] 1.3 Run `pnpm --filter @argus/app test` (or the repo's test script) to confirm the
  existing suite still passes with the stubs in place.

## 2. Pure overflow geometry

- [x] 2.1 Create `packages/app/src/platform/shell/tabs/tabOverflow.ts` exporting
  `TabMetric { id, offsetLeft, width }`, `Viewport { scrollLeft, clientWidth }`, and
  `computeHiddenTabIds(viewport, metrics, tolerancePx = 1): string[]`. A tab is hidden
  when `offsetLeft < scrollLeft - tolerance` or
  `offsetLeft + width > scrollLeft + clientWidth + tolerance`. Preserve `metrics` order
  in the result.
- [x] 2.2 Create `tabOverflow.test.ts` covering: everything fits → `[]`; tabs clipped on
  the right only; tabs clipped on the left after scrolling; a partially-visible tab
  counted as hidden; sub-pixel widths absorbed by the default tolerance; empty
  `metrics` → `[]`; `clientWidth === 0` (pre-layout) → no crash.

## 3. Measurement hook

- [x] 3.1 Create `packages/app/src/platform/shell/tabs/useTabOverflow.ts` exporting
  `useTabOverflow(tabs: Tab[])` → `{ scrollerRef, registerTab, hiddenIds }`.
  `registerTab(id)` returns a stable ref callback that stores/deletes the element in a
  `Map<string, HTMLElement>`.
- [x] 3.2 Recompute `hiddenIds` from the scroller's `scrollLeft`/`clientWidth` and each
  registered element's `offsetLeft`/`offsetWidth`, in `tabs` order, skipping ids with
  no registered element.
- [x] 3.3 Trigger recomputes from: a passive `scroll` listener on the scroller, a
  `ResizeObserver` on the scroller, and a layout effect keyed on the `tabs` array.
  Coalesce into a single `requestAnimationFrame`; cancel any pending frame and
  disconnect the observer on unmount.
- [x] 3.4 Only call `setHiddenIds` when the joined id list actually changes, so
  scrolling does not re-render on every frame.

## 4. TabStrip markup and styles

- [x] 4.1 In `TabStrip.module.css`, split `.root` (flex row, `overflow: hidden`,
  `height: 32px`, keeps the `--bg-elevated` background and bottom hairline) from a new
  `.scroller` (`flex: 1 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden;
  scrollbar-width: thin; display: flex; align-items: stretch;`). Move the horizontal
  padding onto `.scroller`.
- [x] 4.2 Give `.tab` `flex: 0 1 auto; min-width: 96px; max-width: 180px;` and move
  `white-space: nowrap` off `.tab` onto a new `.title` rule
  (`min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`).
  Add `flex-shrink: 0` to `.close`.
- [x] 4.3 Add `.overflowButton` (`flex: 0 0 auto`, fixed width so its size does not vary
  with the count's digit length, hairline left border, `--radius-sm`,
  `--duration-instant` hover per `DESIGN.md`, `--text-muted` → `--text` on hover, and a
  `[data-state="open"]` treatment matching `.groupMenuButton` in `Sidebar.module.css`).
- [x] 4.4 Add `.contextMenu` / `.contextItem` rules copied verbatim from
  `Sidebar.module.css:392-411` so both menus read identically, plus
  `min-width: 180px; max-width: 320px;` a `max-height` with `overflow-y: auto`, and
  per-row ellipsis for long titles.
- [x] 4.5 In `TabStrip.tsx`, wrap the mapped tabs in `<div className={styles.scroller}>`
  and move `role="tablist"` from `.root` onto the scroller so it wraps only the
  `role="tab"` children. Attach `scrollerRef`, and attach `registerTab(tab.id)` as each
  tab's `ref`.
- [x] 4.6 Wrap the tab label in `<span className={styles.title} title={tab.title}>`.
- [x] 4.7 Keep the existing drag/drop, close-button, and click handlers byte-for-byte
  equivalent — no behavioural edits in this task.

## 5. Overflow button and menu

- [x] 5.1 Render the overflow control only when `hiddenIds.length > 0`, as a flex
  sibling of `.scroller` inside `.root`. Use `@radix-ui/react-dropdown-menu` with
  `Portal` + `Content align="end"`, following `GroupHeader.tsx:74-103`.
- [x] 5.2 Trigger: `<ChevronDown size={13} />` plus the hidden count as text, with
  ``aria-label={`Show ${n} hidden ${n === 1 ? "tab" : "tabs"}`}`` and
  `title="Hidden tabs"`.
- [x] 5.3 Render one `DropdownMenu.Item` per hidden tab, resolved from `tabs` in tab
  order (not from `hiddenIds` order alone), each showing the dirty `●` when
  `tab.dirty` and the ellipsised title with a `title` tooltip.
- [x] 5.4 `onSelect` mirrors the tab-click handler exactly: return early if
  `tab.id === activeTabId`, otherwise
  `void shouldActivateTab(activeTabId ?? "").then((ok) => { if (ok) activate(tab.id); })`.
  Do not add a close affordance to menu rows (design Decision 6).

## 6. Keep the active tab visible

- [x] 6.1 In `TabStrip.tsx`, add a `useEffect` with dependency `[activeTabId]` that
  looks up the active tab's element from the ref map and calls
  `scrollIntoView({ block: "nearest", inline: "nearest" })`. Do not depend on
  `hiddenIds` or run it on every render, so manual scrolling is never overridden.
- [x] 6.2 Verify by inspection that this single effect covers every activation path:
  strip click, `cycle` (⌃Tab), command palette, table quick-switcher, overflow menu,
  and `open` (which sets `activeTabId`).

## 7. Tests

- [x] 7.1 Create `TabStrip.overflow.test.tsx`. Render `TabStrip` inside
  `FocusedConnectionProvider` + `TabsProvider` with enough tabs to overflow, then drive
  geometry by `Object.defineProperty(el, "offsetLeft" | "offsetWidth" | "clientWidth" |
  "scrollLeft", { configurable: true, value })` and dispatching a `scroll` event on the
  scroller.
- [x] 7.2 Assert: no overflow button when every tab fits; button present with the
  correct count when tabs are clipped; the menu lists exactly the hidden tabs in tab
  order; a dirty hidden tab shows its indicator in the menu.
- [x] 7.3 Assert selecting a menu entry activates that tab, and that a registered
  activate guard resolving to `false` cancels the activation
  (`registerActivateHandler` from `useCloseConfirm.ts`).
- [x] 7.4 Assert `scrollIntoView` is called on the newly active tab's element when
  `activeTabId` changes, and is not called on unrelated re-renders.
- [x] 7.5 Assert the existing behaviours still hold under overflow: the per-tab close
  button still consults `shouldCloseTab`, and drag-to-reorder still calls `move` with
  the same indices as before.

## 8. Verification

- [x] 8.1 Run the full frontend test suite and the TypeScript build
  (`pnpm --filter @argus/app test` and `tsc --noEmit` / the repo's build script) —
  both clean.
- [x] 8.2 Run the linter over the touched files; no new warnings.
- [ ] 8.3 NOT DONE — needs a live database connection and manual interaction, which I
  cannot drive autonomously. Manual pass in the running app: open ~15 tabs on one connection, confirm the
  strip stops growing, labels ellipsise, the button shows the right count, the menu
  activates and reveals a hidden tab, ⌃Tab reveals off-screen tabs, drag-to-reorder and
  × still work, and switching connections shows the correct per-connection overflow
  state.
- [x] 8.4 Static half done: verified every referenced token is defined in both themes
  (`global.css`), that `var(--radius-sm, 3px)` / `var(--duration-instant, 80ms)` match
  the codebase's existing convention, and that the 32 px strip height, hairline borders
  and "no new colors" rules hold. **Left for the user:** the visual read of the 96/180 px
  bounds and the thin scrollbar in the running app — needs a live connection.
