## Why

Dragging a tab in the Workspace tab strip does not reorder it ([#290](https://github.com/gsulloa/argus/issues/290), reported via in-app feedback on v0.9.0). The feature is written — `TabStrip.tsx` sets `draggable` and wires a full `dragstart → dragover → drop` cycle that calls `move(dragIdx, target)` — but it is the **only** reorder surface in Argus still built on native HTML5 drag-and-drop, and native HTML5 DnD does not work inside the app's WKWebView: Tauri's OS-level drag-drop handler (`dragDropEnabled` defaults to `true` and is never overridden, neither in `tauri.conf.json` nor on the `workspace` window builder) intercepts the drag before the webview sees it, and `dragstart` never calls `dataTransfer.setData()`, which WebKit requires for a drag to initiate at all. Every reorder surface that *does* work — sidebar connections/groups (#208), filter rows (#244), context queries — is built on `@dnd-kit`, which is pointer-events based and immune to both problems.

## What Changes

- **`TabStrip` is ported from native HTML5 DnD to `@dnd-kit`**, matching every other reorder surface in the app. This removes the WebKit `setData()` requirement and the Tauri drag-drop-handler conflict in one move instead of patching them one at a time, and it avoids `disable_drag_drop_handler()` on the `workspace` window — which would work but would also give up OS file-drop on that window forever.
  - A `DndContext` + `SortableContext` with `horizontalListSortingStrategy` wraps the strip (first horizontal sortable in the codebase; the existing three are vertical).
  - Each tab becomes a `useSortable` item keyed on `tab.id`. **The whole tab is the drag affordance** — there is no visible grip handle, unlike `ConditionRow`; a tab strip must stay dense and a grip would be visual noise on a 32px strip.
  - `PointerSensor` with a small activation distance so a plain click still activates the tab and only a deliberate drag starts a reorder, plus `KeyboardSensor` with `sortableKeyboardCoordinates` for parity with the sidebar and filter bar.
  - `onDragEnd` maps `active.id`/`over.id` back to indices and calls the existing `move(from, to)` from `TabsContext` — **the tab model and its `move` reducer are unchanged**.
- **Drag feedback switches from a static insertion caret to live reflow.** The `data-drop-before` / `data-drop-after` box-shadow indicators are removed: a `@dnd-kit` sortable list shifts its siblings out of the way in real time, which *is* the landing-slot affordance, and the two mechanisms are mutually exclusive (a strip that reflows cannot also show a caret pinned to a static tab). The dragged tab keeps its dimmed `data-dragging` treatment. No user has seen the caret, since the drag never started.
- **The three latent defects in the old implementation go away with the code that held them**: the missing `setData()`, the Tauri interception, and the unconditional `onDragLeave` that nulled `dropTarget` when the pointer crossed into a tab's own children (title `<span>`, close button) and made an indicator-less `drop` a silent no-op.
- **Interaction guarantees that must survive the port**: clicking a tab still routes through `shouldActivateTab` before switching; clicking the ✕ still routes through `shouldCloseTab` and must never start a drag; the strip keeps `role="tablist"` and each tab keeps `role="tab"` with `aria-selected` (dnd-kit's sortable `attributes` set `role="button"` by default and must not be allowed to clobber it).
- **`TabStrip` gets its first test file.** `TabStrip.dnd.test.tsx` follows the established `FilterBar.dnd.test.tsx` / `Sidebar.dnd.test.tsx` pattern: mock `@dnd-kit/core` to capture `onDragEnd`, mock `useSortable`, and assert the index mapping and the `move()` call. This is honest about what jsdom can prove — it locks the reorder *logic*, not the WKWebView behaviour that broke the old code. Manual verification in the running app is a required task, not an optional one.

No Rust/Tauri changes, no new dependencies, no persisted-state or schema changes. Not a breaking change.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities

- `app-shell`: the **Center tab system** requirement currently says only that tabs "MUST be … reordered by drag" — one clause, with no stated mechanism and no scenarios, which is exactly the gap that let a non-functional implementation ship. A new **Tab strip drag reordering** requirement pins the contract: reordering MUST be implemented with pointer-events-based drag (`@dnd-kit`), MUST NOT rely on native HTML5 drag-and-drop (which the Tauri drag-drop handler intercepts in the app's webview), a click MUST still activate rather than reorder, closing MUST not start a drag, and the tablist/tab ARIA roles MUST survive the drag wiring.

## Impact

- **Frontend only.**
- `packages/app/src/platform/shell/tabs/TabStrip.tsx` — the whole change. Native DnD handlers and the `dragIdx`/`dropTarget` local state are removed; a `DndContext`/`SortableContext` wrapper and a per-tab sortable item component are added. `useTabs()` consumption is otherwise unchanged.
- `packages/app/src/platform/shell/tabs/TabStrip.module.css` — drop the `[data-drop-before]` / `[data-drop-after]` rules; keep `[data-dragging]`; add the transform/transition wiring a sortable item needs. `overflow-x: auto` on `.root` interacts with dragging and must be verified with enough tabs to overflow the strip.
- `packages/app/src/platform/shell/tabs/TabStrip.dnd.test.tsx` — **new file**; `TabStrip` has no test coverage today.
- Unchanged and explicitly relied upon: `TabsContext.tsx` `move(from, to)` (already clamps out-of-range and `from === to`), `useCloseConfirm.ts` (`shouldCloseTab` / `shouldActivateTab`).
- `@dnd-kit/core@^6.3.1`, `@dnd-kit/sortable@^10.0.0` and `@dnd-kit/utilities@^3.2.2` are already dependencies of `packages/app`. `@dnd-kit/modifiers` is **not**, and the design avoids needing it.
- Deliberately out of scope: `disable_drag_drop_handler()` on the `workspace` window (`packages/app/src-tauri/src/platform/open_connections.rs:202`) and any `dragDropEnabled` change in `tauri.conf.json`. After this change `TabStrip` is the last native-HTML5-DnD surface in the app, so the OS handler stays enabled and available for future file-drop work.
- Related: [#281](https://github.com/gsulloa/argus/issues/281) (tab strip overflow menu) touches the same component; the sortable item is factored out so an overflow menu can be layered on later without re-doing the drag wiring.
