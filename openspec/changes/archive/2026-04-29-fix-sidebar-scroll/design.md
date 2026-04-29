## Context

The sidebar's scroll is broken because the flex chain between `Layout.sidebar` (the only ancestor with a bounded height, `1fr` of `100vh`) and `SchemaTree.body` (the element that *wants* to scroll) is interrupted at three points: `Sidebar.module.css` `.section`, `.list`, and `.subtree` are all flex/block containers without `flex: 1; min-height: 0;`. Result: `.body { flex: 1 }` has no constrained main-axis height to expand into, the scroller stays at content size, `overflow: auto` never triggers, and `Layout.sidebar { overflow: hidden }` clips the overflow silently.

The original spec (`app-shell` → "Sidebar sections may host hierarchical subtrees") mandated that each `SidebarTree` scroll *independently*. That requirement assumed a single dominant tree per active connection consuming the leftover vertical space. With multiple active connections (a supported case), independent scrolls produce N nested scrollers competing for vertical space — there is no defensible way to allocate height between them, and the resulting UX (scroll inside scroll inside scroll) is awkward.

This change moves to a single sidebar-wide scroll context (the VS Code Explorer pattern). One scroll gesture moves through every section and every embedded tree in document order.

## Goals / Non-Goals

**Goals:**

- The sidebar scrolls vertically when its content overflows.
- The whole sidebar (Connections section, every embedded `SchemaTree`, and any future sections) shares one scroll context.
- `SidebarTree` virtualization continues to work for trees with >500 visible nodes.
- No regression in keyboard navigation, focus, or `aria-*` semantics in `SidebarTree`.
- The sidebar resize handle, theme variables, and existing layout tokens remain unchanged.

**Non-Goals:**

- Restoring per-tree independent scroll. Anyone needing it can revisit, but the new model is the default.
- Persisting per-section scroll position across launches.
- Sticky section headers. Out of scope; can be added later as a separate change.
- A horizontal scroller for long labels — labels still ellipsize as today.

## Decisions

### Decision 1: Single scroll context wraps everything below the brand

The brand header (`Sidebar.brand`) stays as a fixed-height row at the top of the sidebar's flex column. Everything else (currently `<ConnectionsSection />`, future sections) is wrapped in a new `<div className={styles.scroll}>` with `flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden`. This element is the single scroll owner for the sidebar.

**Why:** The brand is identity/affordance — it should always be visible. Everything else is browseable content.

**Alternatives considered:**

- *Make `Sidebar.root` itself the scroller.* Loses the always-visible brand.
- *Per-section scrollers.* Defeats the goal — multiple competing scroll regions reappear.

### Decision 2: `SchemaTree.body` and `SidebarTree.scroller` stop owning scroll

- `SchemaTree.module.css` `.body`: drop `flex: 1; min-height: 0; overflow: auto`. Keep `padding: 4px 0`. The body now grows to its natural content height.
- `SidebarTree.module.css` `.scroller`: drop `overflow: auto; max-height: 100%`. Keep `position: relative` (the virtualizer needs a positioned ancestor for its absolutely-positioned rows).

**Why:** Two scroll containers in the same vertical chain produce confusing UX (which one scrolls when you spin the wheel?). Letting the inner trees grow to content height makes the outer sidebar scroller the unambiguous owner.

**Alternatives considered:**

- *Keep the inner scrollers and rely on `overscroll-behavior: contain` to stop wheel events from bubbling.* Still produces nested scrollbars and bad UX with mixed-height content.

### Decision 3: `SidebarTree` accepts an external scroll element for virtualization

`useVirtualizer` from `@tanstack/react-virtual` requires a scroll element (`getScrollElement`). Today `SidebarTree` provides its own `scrollerRef`. With the inner scroller removed, the virtualizer would have nothing to attach to.

Add an optional `scrollElementRef?: React.RefObject<HTMLElement | null>` prop to `SidebarTree`. When provided, the virtualizer uses it; when omitted, the primitive falls back to its current behavior (renders an internal scroller div) so standalone uses still work.

`SchemaTree` (the only current caller) will receive a ref to the sidebar's `.scroll` element via React context (a small `SidebarScrollContext` exposed by `Sidebar`) and pass it down. Using context (rather than prop drilling through `ConnectionsSection` → `ConnectionRow` → `SchemaTree`) keeps the surface small and lets future sections participate without ceremony.

**Why ref via context, not a function call:** The virtualizer reads scroll position synchronously and on every scroll event; refs are the canonical way to hand a DOM node across React boundaries.

**Alternatives considered:**

- *Drop virtualization entirely.* Schemas with thousands of relations exist (e.g., `pg_catalog`-style schemas, multi-tenant DBs). Losing virtualization regresses performance for power users.
- *Window-level virtualization.* `@tanstack/react-virtual` doesn't natively use `window` and the layout root is its own scroll container anyway.

### Decision 4: No spec changes to `postgres-schema-browser`

The schema browser's spec describes *what* the tree contains and *how it activates*, not how it scrolls. Scroll behavior is owned by `app-shell`. Only the `app-shell` "Sidebar sections may host hierarchical subtrees" requirement needs a delta.

## Risks / Trade-offs

- **[Risk] Virtualizer measures wrong when the scroll element is far up the DOM** → Mitigation: pass the actual scroll element ref (not a sentinel); `@tanstack/react-virtual` handles arbitrary scroll ancestors as long as the ref points to the element with `overflow: auto`. Add a smoke test by expanding a schema with >500 relations and verifying only the visible window renders.

- **[Risk] Multiple active connections + large schemas → very tall scroll content** → Acceptable. Users navigate via search (`SchemaSearch`) and palette commands. The same pattern works in VS Code with hundreds of files.

- **[Risk] Scroll position resets when an embedded tree expands/collapses** → Acceptable (matches existing per-tree behavior). If it becomes annoying, we can scroll-anchor to the focused row in a follow-up.

- **[Trade-off] Loss of "scroll within tree, keep sidebar header static"** → Intentional. The sidebar header (brand) stays fixed; everything else is part of the scroll. No section headers are sticky in V1.

- **[Risk] A future module that wants per-section scroll cannot opt in cleanly** → Mitigation: deferred until a real use case appears. The `scrollElementRef` prop on `SidebarTree` already supports that — a section could provide its own bounded scroller and pass its own ref.

## Migration Plan

This is a UI-only change. No data migration, no settings migration. Ship the change, the next launch picks up the new layout. No rollback complexity beyond reverting the commit.

## Open Questions

- Should the new `.scroll` wrapper get a thin custom scrollbar style (matching the rest of the app's chrome) or use the OS default? Defer to design review during implementation.
- Should the brand header acquire a subtle bottom shadow or border when content has scrolled, to signal "more above"? Nice-to-have; out of V1.
