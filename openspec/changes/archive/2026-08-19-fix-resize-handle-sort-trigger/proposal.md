## Why

Releasing a column-resize drag in a data grid also re-sorts the grid by that column, as if the header had been clicked ([#277](https://github.com/gsulloa/argus/issues/277), reported via in-app feedback on v0.8.5). The browser dispatches a synthetic `click` after `pointerup`; `ResizeHandle` is rendered *inside* the sortable header cell and never suppresses that click, so it bubbles to the header's `onClick` and cycles the sort — which in the Postgres/MySQL/MSSQL table viewers also triggers a full re-query. Every resize costs the user an unwanted sort they then have to undo.

## What Changes

- **`ResizeHandle` becomes self-contained with respect to click semantics.** The handle stops the follow-up `click` (and the `dblclick` used for width reset) from propagating to its ancestors. Pointer interaction with the 6px hit area is now guaranteed to *only* resize — never to activate whatever the surrounding header cell does on click.
- **The fix lands once, in the shared component**, so every grid that nests `ResizeHandle` inside a clickable header is covered: Postgres `DataGrid`, Postgres `AdhocResultGrid` (both the populated and the empty-state header rows), MySQL `DataGrid`, MSSQL `DataGrid`, and DynamoDB `TabView`.
- **The DynamoDB `TabView` local workaround is removed.** `TabView` currently wraps `ResizeHandle` in a `<span onClick={stopPropagation} onMouseDown={stopPropagation}>` — the only grid that got a point fix. With the behaviour in the shared component that wrapper is redundant and is deleted, so there is one implementation of this rule rather than two.
- **Sorting by a genuine header click is unchanged.** Clicking the header text, badge, or any part of the cell outside the 6px hit area still cycles the sort (including shift-click multi-sort in the Postgres grid).
- Regression tests cover the handle in isolation and at least one grid end-to-end (drag → release → sort unchanged).

No user-facing API, storage format, or persisted setting changes. Not a breaking change.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `column-width-preferences`: the **Resize handle interaction** requirement gains an explicit event-isolation clause — pointer/click activity on the resize hit area MUST NOT trigger the enclosing header cell's click behaviour (e.g. sort cycling), and the `dblclick` reset MUST likewise not reach the header.

## Impact

- **Frontend only. No Rust/Tauri changes, no schema or migration.**
- `packages/app/src/platform/table/ResizeHandle.tsx` — add `onClick` / `onDoubleClick` propagation stops on the handle element. This is the single behavioural change.
- `packages/app/src/platform/table/ResizeHandle.test.tsx` — new cases asserting a click and a double-click on the handle do not reach an ancestor `onClick`, and that `onReset` still fires on double-click.
- `packages/app/src/modules/dynamo/data-view/TabView.tsx` (~line 599) — remove the now-redundant `<span>` wrapper and its explanatory comment; `ResizeHandle` renders directly in the header cell again.
- Consumers verified as covered with **no code change required**: `packages/app/src/modules/postgres/data/DataGrid.tsx:525`, `packages/app/src/modules/postgres/data/AdhocResultGrid.tsx:396,445`, `packages/app/src/modules/mysql/data/DataGrid.tsx:356`, `packages/app/src/modules/mssql/data/DataGrid.tsx:358`.
- Existing tests that touch the handle and may need review: `packages/app/src/modules/dynamo/data-view/TabView.test.tsx` (clicks the handle via its parent span), `TabView.resize.test.tsx` (asserts on the header cell's child structure), `packages/app/src/modules/postgres/data/__tests__/DataGrid.resize.test.tsx`, `AdhocResultGrid.resize.test.tsx`, `DataGrid.contextMenu.test.tsx`.
- Out of scope: Athena and CloudWatch Insights result panels render their own header rows and do not use `ResizeHandle`; they are unaffected.
