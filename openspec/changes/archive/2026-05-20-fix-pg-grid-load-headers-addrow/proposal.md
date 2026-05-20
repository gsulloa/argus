## Why

Three UX defects in the Postgres table viewer make the data grid feel unreliable and unpolished:

1. **First load occasionally hangs** even though the backend has already returned. The `useTableData` hook's "generation" cancellation token races with React's reset effect on cold mounts (when persisted filter/order-by/page-size settings resolve from disk after the grid is mounted), so the *correct* response gets discarded and the spinner never clears. This violates an existing requirement in `postgres-data-grid` ("Deterministic first-page load on viewer mount").
2. **Column header titles are truncated** at type-derived default widths because the header cell renders the column name, sort badge, type chip, AND resize handle inside a fixed-width header. The type chip is ~60–80px of constant overhead that pushes any non-trivial column name into ellipsis territory even when the cell contents fit fine.
3. **"Add row" does not reveal the new row.** The insert row is prepended at index 0, but the virtualized viewport does not scroll back to the top, so if the user is scrolled down they get no visual feedback and may double-click the button.

All three are scoped to the Postgres data grid surface and ship together as one small, low-risk PR.

## What Changes

- **Fix the first-load race.** Replace the `state.generation`-as-token pattern with a `useRef`-based depsKey token that is bumped synchronously during render, so the cancellation token cannot lag behind the params used in the fetch. The previously-stuck cold-mount path now reaches `ready`.
- **Stop truncating column headers.** Remove the visible `colType` chip from each header (the type is already in the `title` tooltip and on the Structure subtab). Apply a one-shot auto-fit on first load: if the user has no persisted override for a column, use `max(typeBaseWidth, measuredHeaderTextWidth + padding)` so common-length names render fully.
- **Scroll to top on Add row.** Expose an imperative `scrollToTop()` on `DataGrid` via `forwardRef` + `useImperativeHandle`, and call it from `TableViewerTab.onAddRow` right after `buffer.addInsertRow`.

No backend changes. No persisted-data format changes. No new design tokens.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `postgres-data-grid`: tighten the "Deterministic first-page load on viewer mount" requirement to explicitly cover the disk-loaded-settings race; modify the column-header rendering requirement to drop the inline type chip and add auto-fit behavior; add a requirement that "Add row" scrolls the grid viewport to the top.

## Impact

- Affected code:
  - `src/modules/postgres/data/useTableData.ts` (cancellation token refactor).
  - `src/modules/postgres/data/DataGrid.tsx` (header rendering, `forwardRef` for scroll API).
  - `src/modules/postgres/data/DataGrid.module.css` (header layout cleanup).
  - `src/modules/postgres/data/TableViewerTab.tsx` (call new `scrollToTop()` in `onAddRow`).
  - New header auto-fit helper colocated with `DataGrid` (off-DOM canvas measurement).
- Tests:
  - New unit test that reproduces the cold-mount race in `useTableData` (mock async `useSetting` resolution).
  - New `DataGrid` test asserting `scrollToTop` is invoked on `onAddRow`.
  - New `DataGrid` snapshot/test asserting headers no longer render the type chip and that long names are not truncated at default widths.
- No impact on Dynamo data view (`DataViewTab`) — it does not auto-fetch on mount and uses a different grid.
- No impact on the read-only `AdhocResultGrid` (ad-hoc SQL results) beyond inheriting the same header decision if we choose to extend it later (out of scope).
- No persisted-setting migration: existing `pgColumnWidths:*` records continue to apply unchanged; auto-fit only fills in widths the user has not yet customized.
