## Why

The workspace tab strip renders every open tab at its intrinsic width and relies on
horizontal scrolling as its only overflow strategy: `TabStrip` maps the whole `tabs`
array unconditionally, `.root` sets `overflow-x: auto`, and `.tab` has no
`max-width`, no `flex-shrink`, no `min-width: 0`, and pins labels with
`white-space: nowrap`. With a dozen tables open the 32 px strip just keeps growing to
the right, and a tab activated by ⌃Tab or the command palette becomes active while
staying off-screen — nothing scrolls it into view. In-app feedback (issue #281) asks
for the editor-standard treatment: shrink what fits, and put the rest behind a button
at the right end of the strip.

## What Changes

- **Tabs shrink and truncate before they overflow.** `.tab` gains
  `flex: 0 1 auto` with a `min-width` floor and a `max-width` cap; the title span gets
  `min-width: 0` + `text-overflow: ellipsis`, with the full title as a `title`
  tooltip. The dirty dot and close button never shrink.
- **A pinned overflow button appears at the right end of the strip** when one or more
  tabs are not fully visible, showing a chevron plus the count of hidden tabs. It sits
  outside the scrolling region so it stays anchored, and disappears entirely when
  everything fits.
- **Clicking it opens a Radix `DropdownMenu`** listing exactly the tabs that don't
  fit, in tab order, each with its dirty indicator and title. Selecting one activates
  it (through the existing `shouldActivateTab` guard) and scrolls it into view.
- **The active tab is always brought into view** whenever `activeTabId` changes —
  from ⌃Tab, the command palette, the overflow menu, or a tab open — so activation is
  never invisible. Manual user scrolling is not fought.
- Hidden-tab detection is extracted as a **pure function over measured geometry**
  (`scrollLeft`, `clientWidth`, per-tab `offsetLeft`/`width`) so it is unit-testable
  without a real layout engine.
- Horizontal scrolling remains available as a secondary affordance; drag-to-reorder,
  the close button, and the close/activate guards are unchanged.

## Capabilities

### New Capabilities

None. This extends existing tab-strip behaviour rather than introducing a new
capability.

### Modified Capabilities

- `app-shell`: the **Center tab system** requirement gains a companion requirement
  covering tab-strip overflow — label truncation, the hidden-tab overflow button and
  menu, and the "active tab is always visible" guarantee. Existing scenarios for
  opening, switching, closing, reordering, and per-connection scoping are unchanged.

## Impact

**Affected code** (all frontend, `packages/app`):

- `src/platform/shell/tabs/TabStrip.tsx` — wrap the tab row in a scroller element,
  render the overflow button + menu, wire the scroll-active-into-view effect.
- `src/platform/shell/tabs/TabStrip.module.css` — shrink/truncate rules for `.tab`,
  scroller/root split, overflow-button and menu styles.
- `src/platform/shell/tabs/tabOverflow.ts` *(new)* — pure hidden-tab computation.
- `src/platform/shell/tabs/useTabOverflow.ts` *(new)* — measurement hook
  (`ResizeObserver` + `scroll` listener + tab element refs).
- `src/test/setup.ts` — `ResizeObserver` and `Element.prototype.scrollIntoView` stubs
  (jsdom provides neither; nothing in the app uses `ResizeObserver` today).
- New tests: `tabOverflow.test.ts`, `TabStrip.overflow.test.tsx`.

**Dependencies:** none added. `@radix-ui/react-dropdown-menu` and `lucide-react` are
already used by `GroupHeader.tsx`; the menu reuses the shared `.contextMenu` /
`.contextItem` visual treatment from `Sidebar.module.css`.

**Design system:** additive only — hairline borders, `--radius-sm`/`--radius-md`,
`--duration-instant` hover transitions, no new colors. See `DESIGN.md`.

**Risk:** low and contained to the tab strip. The overflow button is purely additive
(absent when nothing overflows), so the common few-tabs case renders as it does today
apart from labels now truncating at a cap.

**Non-goals:** closing tabs from inside the overflow menu, a searchable tab picker
(the command palette and ⌘P quick-switcher already cover search), tab pinning,
multi-row tab strips, and auto-scroll while dragging a tab near the strip edges.
