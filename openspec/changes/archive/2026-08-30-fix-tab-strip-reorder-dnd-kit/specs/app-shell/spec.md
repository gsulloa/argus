## ADDED Requirements

### Requirement: Tab strip drag reordering

The Workspace tab strip SHALL let the user reorder tabs by dragging a tab to a new position within the strip. The reordered order applies to the **focused connection's tab set only** and is the order used by every consumer of that set (rendering, ⌃Tab / ⌃⇧Tab cycling, ⌘W's "previous tab" resolution).

Reordering MUST be implemented with **pointer-events-based drag** (the app's `@dnd-kit` stack: `DndContext` + `SortableContext` with a horizontal sorting strategy, one sortable item per tab keyed on the tab id). Reordering MUST NOT rely on the native HTML5 drag-and-drop API (`draggable` attributes, `dragstart`/`dragover`/`drop`, `dataTransfer`): the app runs in a WKWebView behind Tauri's OS-level drag-drop handler, which intercepts native drags before the webview receives them, and WebKit additionally refuses to start a native drag whose `dragstart` never calls `dataTransfer.setData()`. Native HTML5 DnD therefore cannot be assumed to function on any surface inside the app.

The drag affordance is the **whole tab** — the strip MUST NOT render a separate grip handle. Because the tab body is both the click target and the drag target, a pointer drag MUST only begin after a small deliberate movement threshold, so that a plain press-and-release remains an activation and not a reorder.

The following behaviours MUST survive the drag wiring:

- Clicking a non-active tab activates it, gated by the leaving tab's registered activate handler (`shouldActivateTab`); a tab that is already active does not re-activate.
- Clicking a tab's close (✕) button closes it, gated by the tab's registered close handler (`shouldCloseTab`), and MUST NOT initiate or participate in a drag.
- The strip keeps `role="tablist"`, each tab keeps `role="tab"` and its `aria-selected` state, and each tab remains keyboard-focusable. Drag wiring MUST NOT replace these roles with the sortable library's defaults.

During a drag the dragged tab MUST be visually de-emphasised and the remaining tabs MUST shift live to show the slot the tab will land in. A separate static insertion indicator on a neighbouring tab is not used, since a reflowing strip already communicates the landing slot.

A drag released outside any tab, or released over the tab it started from, MUST leave the order unchanged and MUST NOT re-activate or close anything.

#### Scenario: Dragging a tab to a new position reorders the strip

- **WHEN** the focused connection has tabs `[A, B, C]` in that order and the user drags tab `C` left and releases it over tab `A`
- **THEN** the strip renders `[C, A, B]`
- **AND** the active tab is unchanged by the reorder

#### Scenario: Dragging a tab right past its neighbour

- **WHEN** the focused connection has tabs `[A, B, C]` and the user drags tab `A` right and releases it over tab `C`
- **THEN** the strip renders `[B, C, A]`

#### Scenario: Releasing over the dragged tab itself is a no-op

- **WHEN** the user starts dragging tab `B` and releases it over tab `B`
- **THEN** the tab order is unchanged

#### Scenario: Releasing outside the strip is a no-op

- **WHEN** the user drags tab `B` and releases the pointer where no tab is under it
- **THEN** the tab order is unchanged
- **AND** tab `B` is neither activated nor closed

#### Scenario: A click activates rather than reorders

- **WHEN** the user presses and releases the pointer on an inactive tab without moving it beyond the drag activation threshold
- **THEN** no reorder occurs
- **AND** the leaving tab's activate handler is consulted, and on approval that tab becomes active

#### Scenario: Clicking close does not start a drag

- **WHEN** the user clicks the ✕ button of a closable tab
- **THEN** no drag begins and the tab order is unchanged
- **AND** the tab's close handler is consulted, and on approval the tab closes

#### Scenario: Reordering does not rely on native HTML5 drag-and-drop

- **WHEN** the tab strip is rendered
- **THEN** no tab element carries the native `draggable` attribute
- **AND** reordering is driven by pointer events, so it works in the app's WKWebView with Tauri's OS-level drag-drop handler left enabled

#### Scenario: Tab semantics survive the drag wiring

- **WHEN** the tab strip is rendered with two or more tabs
- **THEN** the strip exposes `role="tablist"` and each tab exposes `role="tab"` with `aria-selected` reflecting whether it is the active tab
- **AND** no tab exposes the sortable library's default `role="button"`

#### Scenario: The strip reflows during a drag

- **WHEN** a tab is being dragged across the strip
- **THEN** the dragged tab is rendered de-emphasised
- **AND** the tabs it passes shift to open the slot it would land in

#### Scenario: Reordering is scoped to the focused connection

- **WHEN** connection A's tabs are reordered to `[C, A, B]` and the user focuses connection B and then returns to connection A
- **THEN** connection A's strip still shows `[C, A, B]`
- **AND** connection B's tab order was not affected by the reorder
