## Context

The table quick-switcher is built on `cmdk`. `PaletteShell` owns the `Cmdk` root and renders `<Cmdk.List>`; `TablePalette` owns the `search` state and the custom `filter` (`scoreTableEntry`). The root is mounted with `value={undefined}` (uncontrolled), so cmdk auto-selects the first item after each re-rank.

cmdk re-orders items and updates the active item on every query change, and natively calls `scrollIntoView` on the selected item. The observed bug is that the `<Cmdk.List>` retains its previous `scrollTop` across query changes: cmdk picks the correct top result, but the container is still scrolled down from the prior query, leaving the best match above the fold. The ranking is already correct (`scoreTableEntry`); only the scroll/viewport coupling is wrong.

## Goals / Non-Goals

**Goals:**
- On every query change, the active/best-ranked row is visible inside the `Cmdk.List` viewport.
- Preserve the empty-search `Recent` group, ↑/↓ keyboard navigation, and Enter-opens-highlighted-row semantics.

**Non-Goals:**
- No change to ranking (`scoreTableEntry`) or to which entry is selected.
- No new dependency, no virtualization rework, no styling change.

## Decisions

**Reset `Cmdk.List` scrollTop to 0 when the query changes.**
Attach a ref to the `<Cmdk.List>` element and, in a `useLayoutEffect` keyed on `search`, set `list.scrollTop = 0` so each fresh result set starts at the top where cmdk has placed the best match. `useLayoutEffect` runs before paint, avoiding a visible jump. Because the list resets to the top and cmdk's selected item is the first item, the active row is in view without additional scroll math.

- *Alternative — controlled `value` synced to the top-ranked entry:* requires `TablePalette` to recompute the winning entry's cmdk `value` string on every keystroke and feed it back through `PaletteShell`, duplicating cmdk's own ranking and risking drift between the highlighted row and the row Enter opens. Rejected as more brittle.
- *Alternative — call `scrollIntoView` on the active element directly:* cmdk already does this for keyboard nav; the gap is the stale container scroll, which a `scrollTop = 0` reset addresses more directly than re-querying the active DOM node.

**Plumb a list ref through `PaletteShell`.**
`PaletteShell` currently hardcodes `<Cmdk.List className={styles.list}>`. Expose an optional `listRef` prop (forwarded to `Cmdk.List`) so `TablePalette` can drive the reset without `PaletteShell` taking on table-specific behavior. The ⌘K command palette passes no ref and is unaffected.

**Reset only on query change, not on every render.**
Keying the effect on `search` (and gating on `open`) means the reset fires exactly when results re-rank, leaving keyboard navigation within a stable result set to cmdk's native `scrollIntoView`.

## Risks / Trade-offs

- [Resetting scrollTop could fight cmdk's own scroll-into-view if both run on the same query change] → `useLayoutEffect` runs after cmdk's commit for the new query; resetting to top and letting cmdk keep the first item selected converge on the same visible state (top of list), so they reinforce rather than fight.
- [Empty-search transition could blank the Recent group's scroll] → effect resets scrollTop to 0, which is the natural top position for the Recent group too; verified by the empty-search scenario.
- [Ref forwarding to `Cmdk.List`] → cmdk's `List` forwards refs to its underlying element; if a future cmdk version changes this, the reset silently no-ops (degrades to current behavior, not a crash).
