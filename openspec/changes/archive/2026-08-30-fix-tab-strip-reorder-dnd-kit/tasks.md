## 1. Strip out the native HTML5 drag-and-drop

- [x] 1.1 In `packages/app/src/platform/shell/tabs/TabStrip.tsx`, delete the `draggable` attribute and the `onDragStart` / `onDragOver` / `onDragLeave` / `onDrop` / `onDragEnd` handlers from the tab element.
- [x] 1.2 Delete the `dragIdx` and `dropTarget` `useState` hooks and the `isDropBefore` / `isDropAfter` derivations, along with the now-unused `useState` import.
- [x] 1.3 In `TabStrip.module.css`, remove the `.tab[data-drop-before="true"]` and `.tab[data-drop-after="true"]` rules. Keep `.tab[data-dragging="true"] { opacity: 0.4 }`.
- [x] 1.4 Confirm no other file references `data-drop-before` / `data-drop-after` (`grep -rn "data-drop-" packages/app/src`); `TabStrip` should be the only user.
  - Verified: the only other hit is `data-drop-into` in `SidebarTree.tsx` / `SidebarTree.module.css`, an unrelated attribute.

## 2. Wire up `@dnd-kit`

- [x] 2.1 Extract a `TabItem` component inside `TabStrip.tsx` taking `{ tab, isActive, onActivate, onClose }`. Move the tab's JSX (dirty ● dot, title `<span>`, ✕ button) into it verbatim. No new file — keep it colocated so #281 can layer an overflow menu on the list, not on the drag wiring.
- [x] 2.2 In `TabItem`, call `const sortable = useSortable({ id: tab.id })`. Set `ref={sortable.setNodeRef}` and `style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}` (import `CSS` from `@dnd-kit/utilities`, mirroring `ConditionRow.tsx`).
- [x] 2.3 Spread `{...sortable.attributes}` and `{...sortable.listeners}` onto the tab `<div>` itself (the whole tab is the drag affordance — no grip handle, per design D2). **Write `role="tab"`, `tabIndex={0}` and `aria-selected={isActive}` AFTER the spread** so they override the sortable defaults (`role="button"`, `tabIndex`). Leave `aria-roledescription="sortable"` from the spread in place.
- [x] 2.4 Drive `data-dragging={sortable.isDragging}` from the sortable state (replacing the old `dragIdx === idx`), and add `zIndex: 1` to the dragging item's style so it renders above its shifting siblings.
  - Dimming stays CSS-driven via `.tab[data-dragging="true"]`; only `zIndex` is applied inline.
- [x] 2.5 Add `onPointerDown={(e) => e.stopPropagation()}` to the ✕ close button so pressing it never arms the pointer sensor (design D7). Keep its existing `onClick` `stopPropagation` + `shouldCloseTab` gate exactly as-is.
- [x] 2.6 In `TabStrip`, build the sensors: `useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))`. 4px matches `Sidebar.tsx`, the other surface where the draggable element is also the click target.
- [x] 2.7 Wrap the `role="tablist"` strip's children in `<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>` → `<SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>`. Memoize `tabIds = tabs.map((t) => t.id)`. Keep `role="tablist"` on the existing `.root` div — do not introduce a new wrapper element that would break the tablist→tab relationship or the `overflow-x: auto` scroll container.
- [x] 2.8 Implement `handleDragEnd` as a `useCallback`: return early when `!over` or `active.id === over.id`; compute `from = tabIds.indexOf(String(active.id))` and `to = tabIds.indexOf(String(over.id))`; return early if either is `-1`; otherwise call `move(from, to)`. Do not re-implement any index arithmetic — `move` already handles the splice and its own bounds guards.
- [x] 2.9 Keep the tab's `onClick` → `shouldActivateTab(activeTabId ?? "")` → `activate(tab.id)` path unchanged, including the "already active — no switch" early return.

## 3. Tests

- [x] 3.1 Create `packages/app/src/platform/shell/tabs/TabStrip.dnd.test.tsx`, modelled on `packages/app/src/modules/postgres/data/filter-bar/FilterBar.dnd.test.tsx`: `vi.mock("@dnd-kit/core")` replacing `DndContext` with a fragment that captures `onDragEnd` into a module-level ref; `vi.mock("@dnd-kit/sortable")` stubbing `SortableContext` as a fragment and `useSortable` as a no-op shape; import `TabStrip` **after** the mocks via `await import`.
  - Deviation from the reference file: the `useSortable` stub returns **realistic** `attributes` (`role: "button"`, `tabIndex`, `aria-roledescription`) rather than `{}`. With `{}` the spread-order guard in 3.11 had no teeth — reversing the order in the component still passed. See the note on 3.11.
- [x] 3.2 Add a header comment stating what this file does and does not prove: it locks the id→index mapping and the no-op guards, but a jsdom test would have passed against the old native-DnD implementation too, so "the drag actually starts" is established by task group 4, not here.
- [x] 3.3 Set up a render helper that gives `TabStrip` three tabs `[A, B, C]` for a focused connection with an observable `move` — either a real `TabsProvider` + `FocusedConnectionProvider` asserting on the rendered order, or a mocked `useTabs` with a `vi.fn()` `move`. Whichever is used, the assertion must distinguish `move(2, 0)` from `move(0, 2)`.
  - Chose the mocked-`useTabs` option: the real providers pull in `useOpenConnections` (Tauri-backed) for no benefit to this component.
- [x] 3.4 Test: dropping `C` over `A` reorders to `[C, A, B]` (i.e. `move` called once with `from=2, to=0`).
- [x] 3.5 Test: dropping `A` over `C` reorders to `[B, C, A]` (`from=0, to=2`).
- [x] 3.6 Test: `over === active` (`{active:{id:"B"}, over:{id:"B"}}`) does not call `move`.
- [x] 3.7 Test: `over === null` does not call `move`.
- [x] 3.8 Test: an id not present in the strip (`{active:{id:"ZZZ"}, over:{id:"A"}}`) does not call `move` — guards the `indexOf === -1` path.
- [x] 3.9 Test: clicking an inactive tab activates it and does not call `move`; clicking the already-active tab does neither.
- [x] 3.10 Test: clicking a tab's ✕ closes that tab (via the `shouldCloseTab` gate) and does not call `move`.
- [x] 3.11 Test: the strip exposes `role="tablist"`, `getAllByRole("tab")` returns one element per tab with correct `aria-selected`, and no tab exposes `role="button"` — the regression guard for the D2 spread-order trap.
  - Guard confirmed to bite: with the spread order deliberately reversed in `TabItem`, 4 of the 10 tests fail (both ARIA tests and both click tests). Reverted after verifying.
- [x] 3.12 Test: no rendered tab carries the native `draggable` attribute (locks the "no native HTML5 DnD" clause of the spec).

## 4. Manual verification in the running app (required — not optional)

**Not executed — needs a human at the running app.** These steps require launching the Tauri
window, live connections, and physical pointer/keyboard drags. 4.3 in particular is the one
open empirical question in the design (`overflow-x: auto` vs. dnd-kit auto-scroll) and its
outcome may require a one-line `autoScroll={false}` follow-up.

- [ ] 4.1 `pnpm -C packages/app tauri:dev`, open a workspace window and open three or more tabs on one connection. Drag the third tab left over the first and release: the strip reorders to `[C, A, B]` and the tabs visibly shift aside during the drag.
- [ ] 4.2 Verify the click/drag split: a plain click on an inactive tab still activates it (no reorder); clicking ✕ closes the tab and never starts a drag; a drag released over the tab it started from leaves the order unchanged.
- [ ] 4.3 Open enough tabs to overflow the 32px strip (`overflow-x: auto` on `.root`) and drag a tab across the scroll boundary. If `@dnd-kit`'s auto-scroll fights the transform or the drop lands on the wrong tab, set `autoScroll={false}` on `DndContext` and note the trade-off (a tab can then only be dragged within the visible region) in the change's design notes.
- [ ] 4.4 Verify per-connection scoping: reorder connection A's tabs, focus connection B in the rail, focus A again — A's new order persisted and B's order is untouched.
- [ ] 4.5 Verify a reorder does not disturb neighbouring behaviour: the active tab stays active, the dirty ● dot stays on the right tab, ⌃Tab / ⌃⇧Tab cycle in the new visual order, and ⌘W closes the active tab and falls back to its new left-hand neighbour.
- [ ] 4.6 Keyboard reorder (new capability, no prior behaviour to regress): focus a tab, press Space, arrow left/right, press Space to drop — the tab moves. If the `KeyboardSensor` conflicts with anything in practice, record the finding rather than silently dropping the sensor.
- [ ] 4.7 Confirm the sidebar connection/group drag, the filter-row drag, and the context-queries drag all still work — the strip's `DndContext` must not interfere with the other contexts on screen.

## 5. Close out

- [x] 5.1 `pnpm -C packages/app typecheck`.
  - Clean.
- [x] 5.2 `pnpm -C packages/app lint`.
  - 0 errors, 91 warnings — all pre-existing `Unused eslint-disable directive` warnings in unrelated files. No warnings in either touched `.tsx`.
- [x] 5.3 `pnpm -C packages/app test:run` — new `TabStrip.dnd.test.tsx` green and the full suite unchanged.
  - 144 files passed / 1 skipped, 1809 tests passed / 3 todo, 0 failures.
- [x] 5.4 Add a CHANGELOG entry under Unreleased → Fixed referencing #290 (tab strip reordering now works; ported to `@dnd-kit`).
- [x] 5.5 Re-read `DESIGN.md` and confirm the drag treatment holds to it: no new borders or radii on the strip, dragged-tab dimming stays at the existing `opacity: 0.4`, sibling shift uses an existing `--duration-*` token rather than an invented one.
  - No new borders or radii; dimming unchanged at `opacity: 0.4`.
  - **Deviation, deliberate:** the sibling shift uses dnd-kit's default `sortable.transition` (200ms), which is not a `--duration-*` token (nearest is `--duration-medium` at 180). `ConnectionRow.tsx` and `ConditionRow.tsx` both use the same default, so overriding it here would make the tab strip the only drag surface with a different feel. Consistency with the three existing surfaces was judged more valuable than matching a token none of them match. Worth resolving app-wide in a separate change rather than one surface at a time.
