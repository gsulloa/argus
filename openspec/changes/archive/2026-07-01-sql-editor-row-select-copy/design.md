## Context

The Postgres SQL editor renders raw-query row results through `AdhocResultGrid`
(`packages/app/src/modules/postgres/data/AdhocResultGrid.tsx`), a read-only,
virtualized grid that shares the same DOM/CSS as the editable `DataGrid` but was
deliberately kept minimal: it supports single-cell selection (`activeCell`) and
single-cell ⌘C copy only. It exposes vestigial `selectedRowIndex` / `onSelectRow`
props, but clicking a cell always calls `onSelectRow(null)`, so no whole-row
selection is ever produced today.

The editable `DataGrid` (`postgres/data/DataGrid.tsx`) already implements the full
model we want to mirror:
- A 32px **row-number gutter** (`GUTTER_WIDTH`). Plain mousedown on a gutter cell
  sets `selection = { anchor: i, active: i }`; shift-mousedown extends
  `{ anchor, active: i }`; dragging over the gutter updates `active` (with
  auto-scroll), using `pixelYToRowIndex` from `postgres/data/dragRowIndex.ts`.
- `selection: { anchor, active }` and `activeCell` are **mutually exclusive**.
- ⌘A → `onSelectionChange({ anchor: 0, active: rows.length - 1 })`.
- ⌘C → single-cell copy when `activeCell != null`, else row-range copy via the
  shared `copyRowRangeFromKeydown` (`platform/grid/gridCopy.ts`).
- Right-click → `RowContextMenu` (`postgres/data/RowContextMenu.tsx`) with Copy
  cell / Copy row(s) / Edit cell / Delete row(s).

The shared copy machinery is already engine-agnostic and DOM-free:
`platform/grid/gridCopy.ts` (`copyRowRangeFromKeydown`, `copyCell`, `copyRows`)
and `platform/grid/cellClipboard.ts` (`formatRowsTSV`, `formatCellValue`). The
row-range path was intentionally moved off the native `copy` event because
WKWebView does not dispatch it for a CSS-only row highlight (issue #213).

`ResultPanel.tsx` (`postgres/sql/`) owns a single `selectedRow: number | null`
today and passes it to both the grid and a slim `RowInspector`.

MySQL/MSSQL SQL editors reuse the editable `DataGrid` in read-only mode, so they
already have gutter selection + row copy. Athena/CloudWatch use bespoke HTML
tables and are out of scope.

## Goals / Non-Goals

**Goals:**
- Bring gutter row-selection (plain / shift-click / drag), ⌘A select-all, ⌘C
  row-range TSV copy, and a read-only Copy context menu to the Postgres ad-hoc
  SQL result grid, matching the editable grid's behavior and output byte-for-byte.
- Reuse the existing shared copy path (`copyRowRangeFromKeydown`) and drag helper
  (`pixelYToRowIndex`) rather than forking logic.
- Drive the SQL editor's right inspector from the (possibly multi-row) selection.
- Preserve the existing single-cell selection + single-cell ⌘C copy exactly.

**Non-Goals:**
- No editing, delete/restore, or bulk-edit in the ad-hoc grid (results are
  immutable — the context menu offers Copy only).
- No changes to MySQL/MSSQL SQL editors (already covered by editable-grid reuse).
- No changes to Athena `SimpleTable` / CloudWatch `InsightsTable` (follow-up).
- No backend, IPC, persistence, or dependency changes. Column-width behavior
  (in-memory, reset on column shape change) is unchanged.

## Decisions

### 1. Make `selection` state internal to `AdhocResultGridInner`, like `activeCell`

The editable `DataGrid` lifts `selection`/`activeCell` to its parent because the
inspector's bulk-edit needs them. The ad-hoc grid already owns `activeCell`
locally. We add a local `selection: { anchor, active }` state next to it and keep
the two mutually exclusive (setting one clears the other), exactly as `DataGrid`
does. The grid then reports the current selection outward via a new
`onSelectionChange?(sel)` prop so `ResultPanel` can feed the inspector.

- **Alternative considered:** lift both to `ResultPanel`. Rejected — it would
  churn the existing `activeCell` ownership and the ad-hoc grid has no other
  consumer of that state; keeping it local minimizes the diff and matches how
  `activeCell` already lives inside the grid.
- **Compatibility:** the existing `selectedRowIndex` / `onSelectRow` props become
  redundant. Replace them with `onSelectionChange`. `ResultPanel` is the only
  caller (confirmed), so this is a safe internal prop change.

### 2. Reuse `copyRowRangeFromKeydown` and `copyCell` from `platform/grid/gridCopy`

The ad-hoc grid currently calls the low-level `copyCellValue` directly. Switch the
keydown handler to the shared coordinator:
- Single-cell path → `copyCell(value, onCopyError)`.
- Row-range path → `copyRowRangeFromKeydown(e, { editing: false, activeCell,
  selection, columnNames, resolveRow, write: writeClipboardText, onError })`.
- `resolveRow(i)` returns `rows[i] ?? null` — ad-hoc rows are already positional
  `CellValue[][]`, so no edit-buffer resolution is needed (unlike `DataGrid`).
- `write` is `writeClipboardText`; failures surface via a toast `onError`.

This guarantees the copied TSV is byte-identical to the editable grids and gets
the WKWebView-safe programmatic clipboard write for free.

- **Alternative considered:** keep calling `copyCellValue`/`copyRowsTsv` inline.
  Rejected — duplicates the guard logic (INPUT/TEXTAREA/edit-mode) and the
  active-cell-vs-range decision the shared helper already encodes.

### 3. Gutter + drag: mirror `DataGrid`, drop the edit/insert/status extras

Add a `GUTTER_WIDTH` (32px) leading column to both the header row and each data
row, showing the 1-based display index. Wire mousedown/shift-mousedown/drag
handlers copied structurally from `DataGrid` (plain → single-row range; shift →
extend from anchor; drag → update `active` with auto-scroll via
`pixelYToRowIndex`). Clicking a data cell keeps its current behavior (set
`activeCell`, clear `selection`). The ad-hoc grid omits the editable grid's
insert-row, status-row, and delete-styling paths.

- **Alternative considered:** extract a shared `useGridRowSelection` hook used by
  both grids. Rejected for this change — larger blast radius on the stable
  editable grid; a follow-up refactor can unify once the ad-hoc behavior is
  proven. We still share the *copy* and *drag-index* helpers (the risky parts).

### 4. Read-only context menu: a Copy-only variant

`RowContextMenu` always renders Edit cell + Delete row(s) items (disabled when
read-only). For the ad-hoc grid we want a menu with only **Copy cell** and
**Copy row(s)**. Prefer generalizing `RowContextMenu` to hide the edit/delete
items when a `readOnly`/`copyOnly` prop is set (single component, one styling
source), rather than a second component. The menu's Copy row(s) copies the target
row, or the whole selected range when the right-clicked row is inside an active
multi-row selection — same rule as the editable grid.

- **Alternative considered:** new `AdhocRowContextMenu` component. Rejected —
  duplicates Radix wiring and `RowContextMenu.module.css`; a prop flag is cheaper.

### 5. Inspector wiring for a row range

`ResultPanel` replaces `selectedRow: number | null` with the grid's
`selection: { anchor, active }`. It computes the selected row indices
(`[min..max]`) and passes the corresponding rows to `RowInspector`'s
`selectedRows` array (the inspector already renders a multi-row read-only view).
Single-row selection — the common case — is just a one-element range, preserving
today's UX. When `activeCell` is set (cell click) the selection is empty and the
inspector clears, matching current behavior.

## Risks / Trade-offs

- **[Divergence from the editable grid's selection logic]** → Copy the gutter/drag
  handlers structurally from `DataGrid` and share `pixelYToRowIndex` +
  `copyRowRangeFromKeydown`; add tests mirroring `DataGrid.copy.test.tsx` so the
  two grids' copy output is verified identical.
- **[Prop-shape change breaks a caller]** (`selectedRowIndex`/`onSelectRow` →
  `onSelectionChange`) → grep confirms `ResultPanel.tsx` is the sole consumer;
  update it in the same change. TypeScript will catch any missed caller.
- **[Generalizing `RowContextMenu` regresses the editable grid]** → gate new
  behavior behind an opt-in prop that defaults to the current (full) menu; the
  editable grid passes nothing and is unaffected. Keep `DataGrid.contextMenu.test.tsx`
  green.
- **[Layout: gutter widens total content width]** → account for `GUTTER_WIDTH` in
  `effectiveTotalWidth`/header width exactly as `DataGrid` does (`totalWidth +
  GUTTER_WIDTH`), and verify the existing `AdhocResultGrid.resize.test.tsx` still
  passes.
- **[WKWebView clipboard]** → mitigated by construction: reuse of
  `copyRowRangeFromKeydown` (programmatic `navigator.clipboard`, no native `copy`
  event) is the exact fix from #213.

## Migration Plan

Pure additive frontend change, no data migration. Ship behind normal release;
rollback is a straight revert of the two touched components (plus the
`RowContextMenu` prop). No feature flag needed — the new affordances degrade to
the current single-cell behavior if selection state is never set.

## Open Questions

- Should the ad-hoc grid also support ⌘C copying **with a header row** when a full
  range is selected? The shared helper reserves `columnNames` for this but does
  not yet emit headers; keep out of scope to stay consistent with the editable
  grids, revisit uniformly later.
