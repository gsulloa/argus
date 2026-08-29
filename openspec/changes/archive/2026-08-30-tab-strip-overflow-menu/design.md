## Context

`TabStrip` (`packages/app/src/platform/shell/tabs/TabStrip.tsx`) is ~100 lines: it reads
`{ tabs, activeTabId, activate, close, move }` from `useTabs()`, maps `tabs` into a flat
flex row, and owns local drag state (`dragIdx`, `dropTarget`). Overflow is handled
entirely by `.root { overflow-x: auto }` in `TabStrip.module.css`. `.tab` has
`white-space: nowrap` and no width constraints of any kind, so the row grows without
bound and the user is left scrolling a 32 px-tall strip. Nothing reacts to
`activeTabId` changing, so ⌃Tab and the command palette can activate a tab that stays
outside the scrollport.

Constraints that shape the design:

- **Width is already bounded by the parent.** `.center` in `Layout.module.css` sets
  `overflow: hidden; min-width: 0`, so the strip's container width is well defined and
  changes only on window/sidebar/inspector resize.
- **Tab sets are per connection.** `useTabs()` already projects the focused
  connection's set (`TabsContext.tsx:329-331`), so the overflow menu reads `tabs` /
  `activeTabId` straight from the hook — no new store, no cross-connection leakage.
- **Guards must be honoured.** Switching tabs goes through `shouldActivateTab(leaving)`
  and closing goes through `shouldCloseTab(id)` (`useCloseConfirm.ts`). Any new
  activation path must route through the same guard the tab click uses.
- **jsdom has neither `ResizeObserver` nor `Element.prototype.scrollIntoView`,** and
  reports `0` for every layout property. Nothing in `packages/app` uses
  `ResizeObserver` today, and `src/test/setup.ts` only imports jest-dom matchers.
  Anything that depends on real measurement is therefore untestable unless the logic is
  separated from the measurement.
- **`DESIGN.md`**: 32 px strip height, hairline borders only, `--radius-sm`/`--radius-md`,
  `--duration-instant` (80 ms) for hover, lucide icons, no new accent colors.

## Goals / Non-Goals

**Goals:**

- Tabs shrink and ellipsise before the strip overflows, so the strip degrades
  gracefully rather than growing without bound.
- When tabs still don't fit, a pinned button at the right end of the strip shows how
  many are hidden and lists them on click; selecting one activates and reveals it.
- The active tab is always visible, regardless of how it was activated (click, ⌃Tab,
  ⌘P, command palette, overflow menu, tab open).
- The hidden/visible split is a pure, unit-testable function of measured geometry.
- Drag-to-reorder, close, dirty indicators, per-connection scoping, and both guards
  behave exactly as they do today.

**Non-Goals:**

- Closing tabs from inside the overflow menu (see Decision 6).
- A searchable tab picker — ⌘K and ⌘P already cover search.
- Tab pinning, multi-row tab strips, tab groups.
- Auto-scrolling the strip while dragging a tab near its edges.
- Persisting scroll position across connection switches or relaunches.

## Decisions

### Decision 1 — Keep horizontal scrolling; add truncation and an overflow menu on top of it

**Choice:** retain the scrollport (`overflow-x: auto`) as the underlying mechanism and
layer three things over it: shrink-to-fit tabs, a scroll-active-into-view effect, and
an overflow button that lists the tabs currently outside the scrollport.

**Alternatives considered:**

- *Fit-based rendering (render only the tabs that fit; hide the rest from the DOM).*
  Requires knowing the width of tabs that are not rendered, which forces either width
  estimation from title length or a hidden measurement pass. It also makes "keep the
  active tab visible" a window-sliding problem, and it removes scrolling — a
  regression for trackpad users. Rejected as materially more complex for no user-visible
  gain.
- *Clip-based (`overflow: hidden`, mark non-fitting tabs `visibility: hidden`).*
  Measurement is exact and single-pass, but with no scrollport there is no way to bring
  a hidden active tab into view short of reordering the DOM, which would scramble the
  user's tab order. Rejected.

The scroll-based design gives **exact** measurement (every tab is in the DOM and laid
out), a trivially correct "bring into view" (`scrollIntoView`), and keeps the existing
scroll affordance. The strip stops *growing* because tabs shrink; overflow only occurs
once every tab is at its `min-width` floor.

### Decision 2 — DOM split: non-scrolling `.root` wrapper + scrolling `.scroller` + pinned button

```
.root      flex row, overflow: hidden, height 32px      ← was the scrollport
  .scroller   role="tablist", flex: 1 1 auto, min-width: 0, overflow-x: auto
     .tab × n
  .overflowButton  flex: 0 0 auto   (rendered only when hiddenIds.length > 0)
```

`role="tablist"` moves from `.root` to `.scroller` so it still wraps exactly the
`role="tab"` children — the overflow button is not a tab and must not sit inside the
tablist. The button is a flex sibling rather than an absolutely-positioned overlay, so
it never covers a tab and needs no opaque background hack; the scroller simply gets
less width when it is present.

Scrollbar: `.scroller` keeps `scrollbar-width: thin` but gains
`&::-webkit-scrollbar { height: 0 }`-equivalent suppression only if it proves visually
noisy in a 32 px strip — otherwise unchanged from today.

### Decision 3 — Shrink/truncate geometry

- `.tab`: `flex: 0 1 auto; min-width: 96px; max-width: 180px;` — tabs shrink toward
  96 px as pressure grows, and never exceed 180 px even with one long-titled tab open.
- The title becomes `<span className={styles.title} title={tab.title}>` with
  `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`.
  `white-space: nowrap` moves from `.tab` to `.title`.
- `.dirtyDot` already has `flex-shrink: 0`; `.close` gains it. Only the title shrinks.
- The native `title` attribute gives the full label on hover, which matters once
  truncation is possible.

96/180 are chosen against a 1280 px window with the default 240 px sidebar, which
leaves ~1020 px of scroller. At a typical natural tab width of ~140 px that fits ~7
tabs with no shrinking at all; shrinking then absorbs up to ~10 tabs before the strip
actually overflows and the button appears. A 96 px floor still shows a useful label
prefix.

### Decision 4 — Pure geometry function + thin measurement hook

The testable core:

```ts
// tabOverflow.ts
export interface TabMetric { id: string; offsetLeft: number; width: number }
export interface Viewport { scrollLeft: number; clientWidth: number }

export function computeHiddenTabIds(
  viewport: Viewport,
  metrics: readonly TabMetric[],
  tolerancePx?: number,   // default 1 — absorbs sub-pixel layout rounding
): string[]
```

A tab is **hidden** when it is not *fully* inside the scrollport:
`offsetLeft < scrollLeft - tolerance` (clipped on the left) or
`offsetLeft + width > scrollLeft + clientWidth + tolerance` (clipped on the right).
Partially visible counts as hidden — a half-cut tab is exactly the case the user is
complaining about. Order of the returned ids follows `metrics` order, which follows tab
order.

The untestable-in-jsdom part is isolated in `useTabOverflow.ts`, which:

- keeps a `Map<string, HTMLElement>` of tab elements via a stable `registerTab(id)`
  ref callback,
- recomputes on `scroll` (passive listener on the scroller), on `ResizeObserver`
  entries for the scroller, and whenever the `tabs` array identity changes,
- coalesces recomputes into one `requestAnimationFrame`,
- returns `{ scrollerRef, registerTab, hiddenIds }`, storing `hiddenIds` in state only
  when the id list actually changes (compare by joined key) so scrolling doesn't
  re-render on every frame.

Guarding `typeof ResizeObserver !== "undefined"` is *not* used — a stub is added to
`src/test/setup.ts` instead, so production and test take the same code path.

### Decision 5 — "Active tab is always visible" is a separate effect keyed on `activeTabId`

A `useEffect` with dependency `[activeTabId]` calls
`el.scrollIntoView({ block: "nearest", inline: "nearest" })` on the active tab's
element. Keying on `activeTabId` (not on every render, and not on `hiddenIds`) is what
keeps it from fighting the user: manual scrolling never re-triggers it, and a tab the
user deliberately scrolled away from stays scrolled away until they activate something.

`inline: "nearest"` is deliberate — it scrolls the minimum distance needed, so an
already-visible active tab produces no movement at all.

This effect covers every activation path at once (click, ⌃Tab via `cycle`, ⌘P,
command palette, overflow menu, and newly opened tabs, since `open` sets
`activeTabId`), which is why it lives here rather than in the menu's click handler.

### Decision 6 — The overflow menu activates only; it does not close

Menu rows are plain `DropdownMenu.Item`s whose `onSelect` mirrors the tab click
handler exactly:

```ts
if (tab.id === activeTabId) return;
void shouldActivateTab(activeTabId ?? "").then((ok) => { if (ok) activate(tab.id); });
```

No per-row close button. Rationale: a nested interactive control inside a
`DropdownMenu.Item` breaks the item's roving-focus/select semantics and needs
`onSelect` preventDefault gymnastics to keep the menu open; the reported need was
*finding* tabs, not closing them; and close already has two working paths (the tab's ×
and ⌘W). If close is added later it MUST route through `shouldCloseTab` — the spec
records that constraint so a future change cannot bypass the dirty-buffer guard.

In practice the active tab never appears in the menu anyway, because Decision 5 keeps
it inside the scrollport — but the `id === activeTabId` early-return is kept for
symmetry and safety.

### Decision 7 — Reuse the `GroupHeader` dropdown pattern and its shared styles

`@radix-ui/react-dropdown-menu` with `<DropdownMenu.Portal>` and
`<DropdownMenu.Content align="end">`, styled with the existing `.contextMenu` /
`.contextItem` rules already used by `GroupHeader.tsx` (`Sidebar.module.css:392-411`).
Those rules are re-declared in `TabStrip.module.css` rather than imported across module
boundaries, matching how the codebase already scopes CSS modules per component; the
values (`--surface`, hairline `--border`, `--radius-md`-class 6 px, `--shadow-md`,
4 px padding, 12 px items) are copied verbatim so the two menus read identically.

Menu-specific additions: `min-width: 180px; max-width: 320px;` a `max-height` with
`overflow-y: auto` for very large tab counts, per-row ellipsis, and the same
`.dirtyDot` treatment as the strip.

Trigger: `<ChevronDown size={13} />` plus the hidden count as text, with
`aria-label={`Show ${n} hidden ${n === 1 ? "tab" : "tabs"}`}` and
`title="Hidden tabs"`. Chevron over hamburger — the feedback said "hamburger button"
but a chevron is the editor convention and matches the app's existing lucide language;
the count is what actually communicates the affordance.

### Decision 8 — Test-environment stubs live in `src/test/setup.ts`

Add a minimal `ResizeObserver` class (`observe`/`unobserve`/`disconnect` no-ops) and,
if absent, `Element.prototype.scrollIntoView = () => {}`. Both are guarded with
`if (!globalThis.X)` so a future jsdom that ships them wins. This is the first
`ResizeObserver` use in the app, so the stub is new rather than a modification.

Component tests then drive geometry by defining `offsetLeft`/`offsetWidth`/
`clientWidth`/`scrollLeft` on the rendered nodes with
`Object.defineProperty(..., { configurable: true })` and dispatching a `scroll` event —
enough to assert the button's presence, its count, and the menu's contents, while
`tabOverflow.test.ts` covers the arithmetic exhaustively with no DOM at all.

## Risks / Trade-offs

- **Measurement loop / render thrash** (`hiddenIds` changes → re-render → layout →
  recompute → …) → mitigated by rAF-coalescing recomputes and by only calling
  `setHiddenIds` when the joined id list actually differs. The overflow button
  appearing/disappearing does change the scroller's width, so a single extra settle
  pass is expected and is bounded: adding the button can only ever *increase* the
  hidden set, and removing it only *decreases* it, so the two states cannot alternate
  once the button's width is accounted for. To be safe the button's width is reserved
  via a fixed `flex-basis` rather than content-sized, so its width does not vary with
  the count's digit length.

- **`scrollIntoView` fighting the user** → mitigated by keying the effect on
  `activeTabId` only, and by `inline: "nearest"` (no movement when already visible).

- **Truncation hides distinguishing suffixes** — `public.orders_2024_q1` vs
  `public.orders_2024_q2` both truncate to the same prefix at 96 px → mitigated by the
  `title` tooltip and by the fact that the 96 px floor is only reached under heavy tab
  pressure; accepted, and identical to VS Code's behaviour.

- **jsdom stubs diverge from browser behaviour** — a no-op `ResizeObserver` means
  component tests never exercise the resize path → mitigated by pushing all decision
  logic into `computeHiddenTabIds`, which is tested directly; the hook only wires
  events to that function.

- **Radix menu inside a 32 px strip** — `align="end"` content could clip against the
  window edge → Radix's collision detection handles this by default; no custom
  positioning.

- **Drag-to-reorder across the scroll boundary** — dragging a tab to a position that is
  scrolled out of view is awkward, but this is the behaviour today and is unchanged.
  Explicitly a non-goal.

## Migration Plan

Pure frontend change, no persisted state, no IPC, no schema. It ships with the app
binary; rollback is reverting the commit. No user data or preferences are touched, so
there is nothing to migrate in either direction.

## Open Questions

None blocking. Two values are deliberately tunable during implementation and should be
confirmed visually against `design/preview.html` before landing:

- The `min-width: 96px` / `max-width: 180px` tab bounds.
- Whether the scroller's thin scrollbar should be suppressed entirely now that the
  overflow button communicates hidden tabs.
