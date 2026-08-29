## Context

`TabStrip.tsx` is a single ~100-line component that renders the focused connection's tab set. It already implements reordering: every tab carries `draggable`, and `onDragStart` / `onDragOver` / `onDragLeave` / `onDrop` / `onDragEnd` maintain two pieces of local state (`dragIdx`, `dropTarget: {index, side}`) and, on drop, compute a destination index and call `move(from, to)` from `TabsContext`. The reducer behind `move` is correct and already guards `from === to` and out-of-range indices.

The drag never starts in the running app. Two independent causes, both confirmed by reading the code:

1. **Tauri intercepts the drag.** `dragDropEnabled` defaults to `true` in Tauri v2 and is overridden nowhere — not in `packages/app/src-tauri/tauri.conf.json`, and not on the `workspace` window builder in `packages/app/src-tauri/src/platform/open_connections.rs` (`WebviewWindowBuilder::new(...).title("Argus").inner_size(...).build()` — no `.disable_drag_drop_handler()`). With the handler on, the OS-level drag machinery consumes the gesture before the webview's HTML5 DnD sees it.
2. **`dragstart` never calls `dataTransfer.setData()`.** It sets `effectAllowed = "move"` and nothing else. WebKit requires at least one `setData()` call for a drag to initiate.

There is a third, latent defect that would bite even with 1 and 2 fixed: `onDragLeave` nulls `dropTarget` unconditionally, so moving the pointer from the tab div into its own children (the title `<span>`, the ✕ button) clears the drop target, and a `drop` that lands without an intervening `dragover` fails the `dropTarget !== null` guard and silently does nothing.

`TabStrip` is the last native-HTML5-DnD surface in the app. Every reorder surface that works is `@dnd-kit`:

| Surface | File | Mechanism | Strategy |
|---|---|---|---|
| Sidebar connections / groups (#208) | `platform/shell/Sidebar.tsx`, `ConnectionRow.tsx` | `@dnd-kit`, `PointerSensor` distance 4 | `verticalListSortingStrategy` |
| Filter rows (#244) | `modules/postgres/data/filter-bar/FilterBar.tsx`, `ConditionRow.tsx` | `@dnd-kit`, `PointerSensor` distance 5 | `verticalListSortingStrategy` |
| Context queries | `modules/context/components/ContextQueriesBranch.tsx` | `@dnd-kit`, `PointerSensor` distance 5, `DragOverlay` | custom, `pointerWithin` |
| **Workspace tab strip** | `platform/shell/tabs/TabStrip.tsx` | **native HTML5 DnD** | — |

`TabStrip` has no test file. `@dnd-kit/core`, `@dnd-kit/sortable`, and `@dnd-kit/utilities` are already dependencies of `packages/app`; `@dnd-kit/modifiers` is not.

## Goals / Non-Goals

**Goals:**

- Dragging a tab reorders it, in the real app, on macOS/WKWebView.
- Bring the strip onto the same drag stack as the rest of Argus, so there is one drag mechanism to reason about and one set of bugs to fix.
- Preserve every existing tab interaction exactly: `shouldActivateTab`-gated click activation, `shouldCloseTab`-gated close, the dirty ● dot, `role="tablist"` / `role="tab"` / `aria-selected`.
- Leave a `TabStrip` test file behind, and be explicit in it about what jsdom can and cannot prove here.
- Leave the component in a shape that #281 (overflow menu) can build on.

**Non-Goals:**

- Changing the tab model, `TabsContext`, or the `move(from, to)` reducer.
- `disable_drag_drop_handler()` on the `workspace` window or a `dragDropEnabled: false` in `tauri.conf.json`. Porting to `@dnd-kit` makes them unnecessary, and disabling the handler would permanently forfeit OS file-drop on that window.
- Dragging a tab **between** connections, or out of the window to detach it. Tab sets stay per-connection.
- The #281 overflow menu itself, tab pinning, or middle-click-to-close.
- Adding `@dnd-kit/modifiers` as a dependency.

## Decisions

### D1 — Port to `@dnd-kit` rather than repair native HTML5 DnD

**Chosen:** replace the native handlers with `DndContext` + `SortableContext`.

**Alternative considered:** keep native DnD and apply both point fixes — `.disable_drag_drop_handler()` on the workspace window builder plus a `dataTransfer.setData("text/plain", tab.id)` in `dragstart`. Rejected on three counts: it costs OS file-drop on the workspace window for a feature nobody is asking to remove; it leaves the app with two drag mechanisms and a fourth surface that behaves unlike the other three; and it is only verifiable by running the packaged app, whereas the `@dnd-kit` path is the one already proven to work in this webview three times over.

### D2 — The whole tab is the drag handle; no grip

`ConditionRow` renders a `GripVertical` handle and spreads `attributes`/`listeners` onto it, because a filter row is a dense field of interactive controls and the grip disambiguates. A tab is 32px tall with at most a dot, a label and a ✕ — a grip would eat a meaningful fraction of it and read as clutter against `DESIGN.md`'s restraint. So `attributes` and `listeners` spread onto the tab `<div>` itself, and the **activation distance** is what separates a click from a drag.

Consequence: the sortable `attributes` include `role="button"` and `tabIndex`, which would clobber the tab's ARIA. `role="tab"`, `tabIndex={0}` and `aria-selected` are therefore written **after** the `{...attributes}` spread in JSX so they win. `aria-roledescription="sortable"` from the spread is kept — it is accurate and additive.

### D3 — `PointerSensor` activation distance 4px, plus `KeyboardSensor`

4px matches `Sidebar.tsx` (the other surface where the draggable element is itself the primary click target); the filter bar's 5px is for a row you never click as a whole. Below the threshold the pointer sequence completes as a normal `click`, so `onClick` → `shouldActivateTab` → `activate` is untouched.

`KeyboardSensor` with `sortableKeyboardCoordinates` is included for parity with the sidebar and filter bar. It costs nothing here: the tab `<div>` has `tabIndex={0}` but **no** `onKeyDown` today, so Space/Enter on a focused tab currently do nothing at all. Wiring the keyboard sensor adds keyboard reordering where there was no keyboard behaviour to regress.

### D4 — `horizontalListSortingStrategy`

First horizontal sortable in the codebase. `closestCenter` collision detection, matching `Sidebar` and `FilterBar` (`ContextQueriesBranch` uses `pointerWithin` because it mixes sortable rows with folder drop targets — not the case here).

No `restrictToHorizontalAxis` modifier: that lives in `@dnd-kit/modifiers`, which is not a dependency, and `horizontalListSortingStrategy` already produces horizontal-only sibling transforms. Vertical pointer wander during a drag simply doesn't change the outcome.

### D5 — Live reflow replaces the static drop indicator

`data-drop-before` / `data-drop-after` (inset accent box-shadows in `TabStrip.module.css`) are removed along with the `dropTarget` state that fed them. A sortable list already animates its siblings aside via `CSS.Transform.toString(transform)` + `transition`, and that reflow *is* the landing-slot affordance; a caret pinned to a static neighbour contradicts a strip whose tabs are moving. `data-dragging` and its `opacity: 0.4` stay, now driven by `sortable.isDragging`.

Issue #290's "Expected" asks for the before/after indicator to show the landing slot. This satisfies the intent by a different mechanism, and no user has seen the caret — the drag it depended on never started.

**Alternative considered:** `DragOverlay` (as in `ContextQueriesBranch`), rendering a floating copy of the tab under the cursor. Rejected as unnecessary here: the strip is a single flat row with no scroll container to escape and no nesting, so the in-place transform reads correctly. Skipping it also keeps the component small for #281.

### D6 — Sortable item extracted as a `TabItem` component

`useSortable` is a hook and cannot be called inside a `.map()` callback in the parent, so each tab must be its own component. `TabItem` stays in `TabStrip.tsx` (not a new file) and takes `tab`, `isActive`, and the three callbacks. This is also what gives #281 a seam: an overflow menu can wrap or slice the list without touching the drag wiring.

### D7 — Close button stops `pointerdown` propagation

The ✕ already calls `e.stopPropagation()` on `click`. With the drag listeners now on the parent, a press on the ✕ would also arm the `PointerSensor`; a user who presses ✕ and drifts >4px before releasing would start a tab drag instead of closing. Adding `onPointerDown={(e) => e.stopPropagation()}` to the close button keeps the ✕ inert with respect to dragging. The dirty ● dot is a non-interactive `<span>` and is deliberately left draggable along with the rest of the tab body.

### D8 — Test strategy: mock the sensors, verify the mapping; verify the drag by hand

`TabStrip.dnd.test.tsx` follows `FilterBar.dnd.test.tsx` verbatim in structure: `vi.mock("@dnd-kit/core")` replacing `DndContext` with a fragment that captures `onDragEnd`, `vi.mock("@dnd-kit/sortable")` stubbing `SortableContext` and `useSortable`, and the component imported *after* the mocks. Tests then invoke the captured `onDragEnd({active: {id}, over: {id}})` and assert against a spied `move`.

This is deliberately honest about its limits and the test file says so in a comment: a jsdom test of the **old** implementation would have passed too, because jsdom dispatches synthetic drag events with none of the WKWebView or Tauri behaviour that broke it. What these tests lock is the index mapping and the no-op guards — the parts that are pure logic. The claim "the drag works" is established by the manual verification task in the running app, which is a required task, not a nice-to-have.

`TabStrip` renders `useTabs()` state, so the tests wrap it in a `TabsProvider` + `FocusedConnectionProvider` (or mock `useTabs` directly, whichever the existing test helpers make cheaper — `move` must be observable either way).

## Risks / Trade-offs

- **The port compiles and passes tests but the drag still doesn't work in the app.** → The only real refutation is running it. The manual verification task (task group 4) is required and specifies the exact gestures. Mitigating prior: three `@dnd-kit` surfaces already work in this exact webview.
- **`overflow-x: auto` on `.root` interferes with the drag.** The strip scrolls horizontally once tabs overflow; `@dnd-kit` measures droppable rects against the scroll container and mid-drag auto-scroll can fight the transform. → Explicitly verified with enough tabs to overflow the strip (task 4.3). If auto-scroll misbehaves, `autoScroll={false}` on `DndContext` is the escape hatch, at the cost of not being able to drag a tab past the visible edge.
- **Sortable `attributes` clobbering `role="tab"`.** A spread-order slip silently downgrades the strip's ARIA and breaks any `getByRole("tab")` query. → Covered by an explicit assertion in the test file (scenario "Tab semantics survive the drag wiring").
- **A slow, jittery click on a tab crosses the 4px threshold and reorders instead of activating.** → 4px is the value already shipping on sidebar connection rows, which have the same click-and-drag duality; releasing over the origin tab is a no-op, so the worst case is a one-slot shift, undone by a drag back.
- **`move()` is index-based, `@dnd-kit` is id-based.** `onDragEnd` maps ids → indices via the rendered `tabs` array. A stale array would move the wrong tab. → The mapping is computed inside the handler from the current `tabs` (which is `useCallback`-deped on it), and `move` re-derives from `focusedConnectionId` state at commit time; its own bounds guard covers `-1` from a missing id, but the handler returns early on `indexOf === -1` rather than relying on that.
- **Keyboard reordering is newly reachable and untested by hand.** → Low blast radius (no prior keyboard behaviour on the tab element to regress), and it is included in manual verification.

## Migration Plan

None. No persisted state, no schema, no IPC surface, no user-visible setting. The change is a component rewrite behind an unchanged `useTabs()` contract; rollback is reverting the commit.

## Open Questions

- None blocking. Whether to add `autoScroll={false}` is settled empirically during task 4.3 rather than decided in advance.
