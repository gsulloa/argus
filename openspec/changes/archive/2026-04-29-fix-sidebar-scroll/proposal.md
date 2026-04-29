## Why

The left sidebar cannot be scrolled when its content (connections + active schema trees) overflows the window height. The current implementation is broken: `SchemaTree.body` declares `flex:1; min-height:0; overflow:auto`, but none of its ancestors (`section`, `ul.list`, `subtree`) participate in flex sizing, so `.body` resolves to its content height and the `overflow:auto` never triggers. The sidebar is clipped silently by `Layout.sidebar { overflow: hidden }`. With multiple expanded schemas — or even a single large schema — users can't reach the items below the fold.

## What Changes

- **BREAKING (spec-level)**: Replace per-tree independent scrolling with a single sidebar-wide scroll context. The whole sidebar (everything below the brand header) becomes one scrollable column; embedded `SidebarTree` instances grow to their content height and contribute to that scroll.
- Add a scroll wrapper element inside `Sidebar` that owns `flex:1; min-height:0; overflow-y:auto`.
- Remove `flex:1; min-height:0; overflow:auto` from `SchemaTree.body` and `overflow:auto; max-height:100%` from `SidebarTree.scroller` so they stop fighting the new scroll owner.
- Update `SidebarTree`'s virtualizer to accept an external scroll element (so trees larger than 500 nodes can still virtualize against the sidebar's scroll context). When no external element is provided, fall back to the existing internal scroller for standalone uses.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `app-shell`: Change the "Sidebar sections may host hierarchical subtrees" requirement — trees no longer scroll independently; the sidebar provides a single scroll context shared across all sections and embedded trees.

## Impact

- **Code**:
  - `src/platform/shell/Sidebar.tsx` + `Sidebar.module.css` (new scroll wrapper)
  - `src/platform/shell/SidebarTree.tsx` + `SidebarTree.module.css` (drop internal scroller; accept external scroll element via prop or context)
  - `src/modules/postgres/schema/SchemaTree.module.css` (drop `.body` flex/overflow rules)
- **APIs**: `SidebarTree` gains a new optional prop (e.g. `scrollElementRef`) to point the virtualizer at an external scroll container. Existing call sites in this repo (`SchemaTree`) pass it; standalone uses keep working without it.
- **UX**: Single-gesture scroll for the whole sidebar (VS Code Explorer-style). With multiple active connections, all trees scroll together rather than competing for vertical space.
- **Tests / specs**: `app-shell` spec scenario "Multiple trees can be visible simultaneously" is rewritten to assert shared-scroll behavior.
