## Context

The Postgres data grid (`src/modules/postgres/data/DataGrid.tsx`) implements a virtualized table where each visible row is a `<div>` with a row-level `onMouseDown` handler that initiates a drag-to-select state machine (`pending` → `active`). On mouseup, the handler either finalizes a multi-row range or, if the cursor never moved past the 4px threshold, treats it as a single click. The single-click branch currently toggles deselect when the clicked row is already the sole selected row.

Two pieces of state interact badly in practice:

1. **Native text selection.** Neither `.row` nor `.cell` in `DataGrid.module.css` declares `user-select: none` (only `.headerCell` does). When the user mousedowns on a text node inside a cell and starts dragging, the browser begins a native text-selection. Native text-selection competes with the row's drag state machine: it visibly highlights cell contents, alters cursor styling, can suppress `mousemove` event dispatch in some browsers / Webview2 builds, and in all cases produces a visually broken experience that does not look like row drag-select.

2. **Toggle-deselect on click.** The mouseup handler at `DataGrid.tsx:250-262` checks if the row clicked was already the sole selected row and, if so, sets selection to `{ anchor: null, active: null }`. The user reports this as "selecting one deselects it on its own" — every second interaction with the same row, or any flow where the row was just selected and the user clicks it again to confirm, results in immediate deselection.

The intended interaction model is **single click → select row (no toggle)**, **drag → select range (no text selection)**, **double-click → enter cell edit mode**, **Escape / Clear chip → deselect**. The cell editor itself (input/textarea/select inside `.cellEditing`) must remain text-selectable so users can navigate text inside the editor normally.

## Goals / Non-Goals

**Goals:**
- Restore reliable single-row selection: a single primary-button click on any row sets that row as the selection, period.
- Restore reliable drag-to-select-rows: dragging anywhere in the grid body extends a row range and never starts a native text selection.
- Preserve the existing double-click-to-edit affordance for editable cells, including text auto-select inside the editor.
- Keep the existing 4px drag threshold so accidental micro-motions during a click still register as clicks.
- Keep all existing deselection paths (Escape, Clear chip, sort/filter/page-size change) working.

**Non-Goals:**
- Adding Cmd-click / Shift-click extend semantics (already out of scope per the existing requirement; not changing here).
- Column-level / cell-level selection (selection remains row-range).
- Touch / pointer-event refactor. The implementation stays on mouse events; touch is not supported by Argus today.
- Changing the bulk-edit or bulk-delete behavior triggered by the selection.
- Changing the inspector panel binding to the `active` index.

## Decisions

### Decision 1: Suppress native text selection via CSS, not JS

**Choice:** Add `user-select: none` (with `-webkit-user-select: none` for the Tauri Webview) to the `.row` and `.cell` rules in `DataGrid.module.css`. Re-enable `user-select: text` on `.cellEditing` (the wrapper) and on `.cellEditor` (the input/textarea/select).

**Why over alternatives:**
- *Alternative A: only `e.preventDefault()` in the row mousedown.* This works in Chromium and prevents the text-selection from starting, but `user-select: none` is also needed because the user can also start a text-selection via keyboard (Shift+arrow on a focused text node) or via a click that lands on a text node before any drag. CSS is the durable answer; the JS preventDefault is the belt-and-suspenders second layer for the drag itself.
- *Alternative B: wrap cell content in a `pointer-events: none` overlay.* Breaks tooltips (`title=`) and would interfere with the double-click target hit-testing; rejected.
- *Alternative C: only suppress when dragging is active (toggle a CSS class on `<body>`).* Adds state complexity for no benefit — there is no legitimate reason for a user to want to select cell text in the display path; if they need the text, they double-click to enter the editor (which auto-selects all text and is copyable). Rejected.

### Decision 2: Also call `e.preventDefault()` in the row's `onMouseDown`

**Choice:** Add `e.preventDefault()` at the top of the row's `onMouseDown` handler (after the `e.button !== 0` guard). This prevents the browser from initiating focus-change / text-selection / drag-image behavior on the mousedown itself.

**Why:** CSS `user-select: none` prevents new text-selection inside the row's subtree, but a mousedown that starts on a `.row` and drags into another DOM node could still trigger a focus/drag event chain that interferes with our drag state machine. `preventDefault()` on mousedown is the canonical way to suppress this. It does NOT prevent the subsequent `dblclick` event from firing in any modern browser — `dblclick` is dispatched as a synthesized event after two `mousedown`/`mouseup` pairs and is not gated by mousedown's `defaultPrevented` flag, so double-click-to-edit is unaffected.

**Risk:** Some browsers historically used `preventDefault` on mousedown to suppress focus shifts, which could affect the grid root's `tabIndex={0}` focus handling. The grid root receives focus from the mouseup handler (`rootEl?.focus()` at DataGrid.tsx:266) and that path is preserved, so keyboard handling (Escape, Backspace) is unaffected.

### Decision 3: Remove the toggle-deselect-on-click branch entirely

**Choice:** In the mouseup handler, when `drag.status === "pending"` (i.e., it's a click not a drag), unconditionally set selection to `{ anchor: drag.anchorIndex, active: drag.anchorIndex }`. Delete the `isSingleRowSelected` branch.

**Why over alternatives:**
- *Alternative A: keep toggle but guard it behind a modifier key (e.g., Cmd-click toggles).* Adds a hidden interaction with no UI affordance and conflicts with future Cmd-click-extend semantics. Rejected.
- *Alternative B: keep toggle only when the user clicks an already-active row a second time within N ms.* Fragile, surprises users, and the user explicitly described this as a bug. Rejected.

The "click an already-selected row to deselect" idiom is rare in production data grids (DataGrip, TablePlus, pgAdmin all keep the row selected on re-click; deselection is an explicit affordance via Escape or empty-space click). Removing it aligns Argus with that convention and resolves the user's complaint directly.

### Decision 4: Keep the existing 4px threshold and `pending` → `active` transition

**Choice:** No change to drag thresholding logic or to the `active` branch of mouseup. Multi-row drag still works as specified.

**Why:** The threshold prevents jittery clicks from being misclassified as drags. The user's report is specifically about single-click and text-drag failures; multi-row drag itself is reportedly broken only because native text-selection visually masks it. Once text-selection is suppressed (Decisions 1 + 2), the existing `active` path will work as designed.

### Decision 4b: Memoize `useTableFilter`'s normalized output (discovered during QA)

**Choice:** In `src/modules/postgres/data/useTableFilter.ts`, wrap `normalizePersistedFilter(raw)` in `useMemo(..., [raw])` so the returned `{ draft, applied }` keep stable references across renders.

**Why:** Manual QA after Decisions 1–3 showed that even with `preventDefault` and toggle-deselect removed, selections still cleared themselves on any state change. The culprit was `TableViewerTab.tsx:200`, a `useEffect` that resets `selection` whenever `[pageSize, orderBy, applied, connectionId, schema, relation]` changes. `useTableFilter` was calling `normalizePersistedFilter(raw)` directly in the render body, which produces a new `FilterModel` object every render — so the `applied` dep was effectively never stable, and the effect fired on every render (including the `setDragActive(true)` re-render from mousedown and the `setSelection(...)` re-render from mouseup).

**Why over alternatives:**
- *Alternative A: change the `useEffect` deps in `TableViewerTab.tsx` to a primitive signature (e.g., `JSON.stringify(applied)`)*. Local fix but doesn't address the root cause. Two other `useEffect`s in the same file (count-fetch trigger, error reset) also depend on `applied` and would still misfire — they refetched the row count and reset state on every render. Memoizing the source of `applied` fixes all three at once.
- *Alternative B: stop normalizing on read; migrate stored records once on write*. Bigger surface, more risk; the `combinator ?? "AND"` coercion is cheap and defensive. Rejected.

**Risk:** `useMemo` only stabilizes when `raw` (the underlying value from `useSetting`) is reference-stable. Confirmed: `useSetting` returns its `useState`-backed `value`, which is stable unless the user calls the setter. The memo's identity is therefore guaranteed across renders that don't change the persisted filter.

### Decision 5: Re-enable text selection inside the cell editor

**Choice:** Add `user-select: text` (and `-webkit-user-select: text`) to `.cellEditing` and `.cellEditor` in the CSS. The `<input>`, `<textarea>`, and `<select>` natively allow text selection in their value regions, but the wrapping `.cellEditing` div inherits `user-select: none` from `.cell` (CSS inheritance applies to `user-select` in most engines), so we re-enable it explicitly on the editor wrapper.

**Why:** Without this, edge cases like clicking outside the input but inside the `.cellEditing` wrapper (e.g., the small padding region) could fail to select text, and copy-from-editor flows could break in the Tauri Webview. Defensive but cheap.

## Risks / Trade-offs

- **[Risk] Users who relied on click-to-deselect lose that gesture.** → Mitigation: `Escape` already clears selection; the `Clear` chip in the bottom bar already clears multi-row selection (and we can extend it to also appear for single-row if user feedback demands it, but that is out of scope here). The proposal flags this as a user-visible breaking change.
- **[Risk] `preventDefault()` on mousedown could suppress focus on form elements rendered inside cells in some future column type (e.g., a checkbox column).** → Mitigation: there are no such elements today (all interactive cell content lives in `.cellEditing`, not in the display path). If introduced later, the handler can be scoped to only call `preventDefault` when the event target is the row div itself, not an interactive descendant.
- **[Risk] `user-select: none` on cells means users can no longer "copy the value as displayed".** → Mitigation: users can double-click the cell to open the editor, which auto-selects all text (`cur.select()` at EditableCell.tsx:209) and supports Cmd-C. This is a deliberate trade-off: making the display path text-draggable is what created the bug.
- **[Risk] The Tauri Webview2 (Windows) and WKWebView (macOS) may treat `user-select` slightly differently.** → Mitigation: the rule is supported in both engines; include the `-webkit-` prefix as a safety. Manually verify on macOS during QA (Windows build is out of scope for V1 but should still render correctly).
- **[Trade-off] No automated test for drag behavior.** The grid has no Playwright / vitest coverage for mouse events. Verification is manual. This is consistent with the rest of the data-grid surface and not a regression introduced by this change.
