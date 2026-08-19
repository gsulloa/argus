## Context

`ResizeHandle` (`packages/app/src/platform/table/ResizeHandle.tsx`) renders a 6px, absolutely-positioned `<div>` over the right edge of a header cell and owns the whole pointer lifecycle: `pointerdown` (capture + record `startX`/`startWidth`), `pointermove` (live `onChange(clampWidth(...))`), `pointerup` / `pointercancel` (release + restore body styles), and `dblclick` → `onReset()`.

It does not touch mouse-compat events. After a pointer press-and-release, the browser still dispatches `mousedown`/`mouseup` and then a `click` at the element the pointer was captured to — i.e. the handle. `e.preventDefault()` in `handlePointerDown` suppresses text selection and drag-start, but it does **not** suppress that follow-up `click`. So the click bubbles out of the handle into the header cell, which in every SQL grid carries the sort handler:

| Grid | Header `onClick` |
|---|---|
| `modules/postgres/data/DataGrid.tsx:511` | `onSortChange(cycleSort(col.name, orderBy, e.shiftKey))` → re-query |
| `modules/postgres/data/AdhocResultGrid.tsx:438` | `handleHeaderClick(col.name)` (client-side sort) |
| `modules/mysql/data/DataGrid.tsx:325` | `onSortChange(...)` → re-query |
| `modules/mssql/data/DataGrid.tsx:327` | `onSortChange(...)` → re-query |
| `modules/dynamo/data-view/TabView.tsx:579` | `header.column.getToggleSortingHandler()` |

Every resize therefore also sorts. In the three server-side grids it additionally fires a network round-trip.

DynamoDB `TabView` already worked around this locally (`TabView.tsx:599-610`) by wrapping the handle in a `<span onClick={stopPropagation} onMouseDown={stopPropagation}>`. That is the only grid that is currently correct, and it fixed the symptom at the call site instead of in the component that owns the gesture. The empty-state header row in `AdhocResultGrid.tsx:396` is the one handle instance with no sortable ancestor today — it must keep working unchanged.

Constraints: frontend-only; React 18 synthetic events delegated at the root container; the handle must keep its existing `onReset` double-click contract; jsdom-based Vitest suite already polyfills `setPointerCapture`.

## Goals / Non-Goals

**Goals:**

- A resize gesture (drag, or a plain click, or a double-click reset) on the hit area never activates the enclosing header cell's click behaviour.
- The rule lives in `ResizeHandle` once, so all five consuming grids are fixed by the same edit and any future grid inherits it.
- Genuine header clicks — anywhere in the cell outside the 6px hit area — keep cycling the sort exactly as today, including Postgres's shift-click multi-sort.
- Remove the DynamoDB point fix so there is a single implementation of the rule.

**Non-Goals:**

- No change to width computation, clamping, persistence, or the `[56, 800]` bounds.
- No change to any grid's sorting semantics or to the sort indicator.
- No "did the pointer actually move?" threshold. A click on the 6px hit area is never a sort intent regardless of distance travelled, so distinguishing drag from tap adds state for no behavioural gain.
- Athena and CloudWatch Insights result panels are untouched — they render their own headers and do not use `ResizeHandle`.

## Decisions

### Decision 1: Suppress the click inside `ResizeHandle`, not at each call site

Add `onClick={(e) => e.stopPropagation()}` to the handle `<div>`, and call `e.stopPropagation()` in the existing `handleDoubleClick` before `onReset()`.

*Why:* the handle is the component that owns the gesture; its call sites should not have to know that a pointer drag emits a trailing click. Five call sites exist today and four of them are already wrong, which is exactly the failure mode a per-call-site rule produces. One edit in the shared component fixes all of them and makes new grids correct by default.

*Alternatives considered:*

- **Wrapper `<span>` with `stopPropagation` at each call site** (the current DynamoDB approach). Rejected: N places to get right, keeps regressing, and adds a DOM node between the header cell and the absolutely-positioned handle for no reason.
- **A "did we just drag" guard consulted by each header's `onClick`** (as floated in the issue). Rejected: requires shared mutable state (a module-level timestamp or a context) read by five unrelated header handlers, and it still lets a non-drag click on the hit area sort the column. Strictly more machinery for strictly worse behaviour.
- **`preventDefault()` on `pointerup`/`mouseup`.** Rejected: `preventDefault` on `mouseup` does not reliably suppress the subsequent `click` across browsers, and even where it does, the click would still fire in the no-movement case. `stopPropagation` on `click` is the direct, well-defined mechanism.
- **`stopPropagation` in the capture phase on the header cell.** Rejected: inverts ownership — the header would need to know the handle's geometry.

### Decision 2: Stop `click` unconditionally, not only after a drag

The handler stops every click on the hit area, whether or not `dragRef` was populated.

*Why:* the hit area is a 6px control with its own affordance (`cursor: col-resize`, accent line on hover). A user who clicks it is aiming at the resizer, not at the header. Gating on "was there a drag" would leave a real bug — press-release without movement re-sorts — and would need drag state kept alive past `pointerup` just to answer the question.

### Decision 3: Do not stop `mousedown`

The DynamoDB wrapper also stopped `mousedown`. The new implementation does not.

*Why:* no header cell in any of the five grids has a `mousedown` handler, and none of the header rows participate in the grids' drag-to-select row logic (that lives on the body). Stopping `mousedown` would be dead code today and could suppress a legitimate future ancestor behaviour. If a header ever gains `mousedown` behaviour, the same one-line pattern extends to it. `pointerdown` already calls `preventDefault()`, which is what actually matters for text selection.

### Decision 4: Delete the DynamoDB wrapper in the same change

`TabView.tsx` reverts to rendering `<ResizeHandle …/>` directly in the header cell.

*Why:* leaving it would mean two mechanisms enforcing one rule, and the redundant `<span>` is a real (if small) trap for anyone reading the header markup. Deleting it in the same change also proves the shared fix actually covers the DynamoDB case, since `TabView`'s existing resize tests would fail if it did not.

*Risk:* two DynamoDB tests reach into the header cell's child structure (`TabView.test.tsx:681-688` clicks the handle "via its parent span"; `TabView.resize.test.tsx:406-445` counts `div` children to assert handle presence/absence). Removing the `<span>` changes that structure, so both need to be re-pointed at the handle element itself. This is expected churn, not a regression — see Risks.

## Risks / Trade-offs

- **DynamoDB tests coupled to the wrapper `<span>` break when it is removed** → they are updated in the same change to select the handle directly (by its CSS-module class, as `TabView.resize.test.tsx` already does in places). The assertions themselves — "More… has no handle", "resizable columns have a handle" — are unchanged in meaning.
- **A click on the hit area now does nothing at all if the user was aiming at the header** → accepted, and it is the correct trade: the hit area is 6px, it renders a `col-resize` cursor and an accent line on hover, and the rest of the header cell (typically 56-800px) remains a sort target. Losing an accidental sort is strictly better than firing an unwanted one plus a re-query.
- **`stopPropagation` could hide the click from a legitimate future ancestor listener** (e.g. a header context-menu or column-reorder feature) → the stop is scoped to the 6px handle only, and any such feature would want the same exclusion anyway. `DataGrid.contextMenu.test.tsx` exercises the body's context menu, not the header, so it is unaffected.
- **React's delegated event system** attaches listeners at the root container, so `stopPropagation` on the synthetic event prevents React from invoking ancestor React handlers — which is precisely the set of handlers involved here. No native non-React listener on the header rows exists to bypass it.
- **Regression surface is one component** used by five grids, covered by an isolated unit test plus at least one grid-level test that drags and asserts the sort callback was not called. Rollback is reverting a two-line change.

## Migration Plan

None required. No persisted data, settings key, IPC command, or public API changes. The fix is behavioural and takes effect on the next app build; existing `pgColumnWidths:*` / `dynamoColumnWidths:*` records are untouched.

## Open Questions

None. The reproduction, the mechanism, and the affected call sites are all confirmed by reading the source.
