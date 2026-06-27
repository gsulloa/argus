## Context

Argus has three editable data grids (Postgres, MySQL, MSSQL) and three read-only result grids (Postgres `AdhocResultGrid`, Athena `SimpleTable`, CloudWatch `InsightsTable`). All six support single-cell selection + ⌘C copy via the shared `copyCellValue` / `formatCellValue` in `packages/app/src/platform/grid/cellClipboard.ts`.

Only the three **editable** grids carry a row-range selection model — `selection: { anchor, active }` row indices, populated by drag-select and shift-click — mutually exclusive with the single active cell. Current state of row-range copy in those three:

- **MySQL** (`mysql/data/DataGrid.tsx` ~L153-176) and **MSSQL** (`mssql/data/DataGrid.tsx` ~L157) already implement row-range TSV copy via a `window.addEventListener("copy", …)` handler that early-returns when a single cell is active, then joins `rows[i].cells.map(formatCellValue)` with `\t` / `\n` and writes via `e.clipboardData.setData`. They do **not** consult the edit buffer, so copied values are stale when a row has pending edits.
- **Postgres** (`postgres/data/DataGrid.tsx` ~L193) has only the single-cell ⌘C branch in `onGridKeyDown`; there is no row-range copy at all. Its single-cell branch already resolves the edit-aware display value via `buffer.getRowEdits(rowKey)`.

The read-only grids have only `activeCell` (no anchor/active), so row copy does not apply to them.

## Goals / Non-Goals

**Goals:**
- Postgres grid copies a selected row range as TSV on ⌘C/Ctrl+C, matching MySQL/MSSQL.
- A single shared `formatRowsTSV` helper produces the TSV so all three grids are byte-for-byte consistent and unit-testable.
- Copied rows reflect pending in-buffer edits in all three editable grids.
- Cell formatting in a copied row is identical to single-cell copy (same `formatCellValue`).
- Single-cell copy keeps precedence; the two selection modes stay mutually exclusive.

**Non-Goals:**
- Row copy in read-only grids (no row-range selection model exists there).
- Alternative formats (SQL `INSERT`, JSON), a header row, a context-menu entry, or row duplication/clone — all explicitly deferred.
- Changing the selection model, drag-select, or shift-click behaviour.

## Decisions

### Decision 1: Shared pure formatter `formatRowsTSV(rows: unknown[][]): string`
Add to `cellClipboard.ts`:
```ts
export function formatRowsTSV(rows: unknown[][]): string {
  return rows.map((cells) => cells.map(formatCellValue).join("\t")).join("\n");
}
```
- **Why a pure formatter (not a `copyRowsTSV` that writes the clipboard):** the editable grids write the clipboard from inside a native `copy` event using `e.clipboardData.setData(...)` synchronously — they cannot use the async `navigator.clipboard.writeText` that `copyCellValue` uses without risking the event completing first. So the shared piece is the string construction; each grid owns the write. This keeps the helper trivial to unit-test (no clipboard mock) and reuses `formatCellValue` so single-cell and row copy never diverge.
- **Alternative considered:** a `copyRowsTSV` that calls `navigator.clipboard.writeText`. Rejected — it would diverge from the existing, working `copy`-listener pattern in MySQL/MSSQL and reintroduce async-in-event fragility.
- **Input shape:** `unknown[][]` — caller maps each selected row to a fully **edit-resolved** array of cell values before calling. This pushes per-engine buffer differences (Postgres `buffer.getRowEdits` vs MySQL/MSSQL `buffer.getDisplayValue`) to the caller and keeps the helper engine-agnostic, exactly as `formatCellValue` already is.

### Decision 2: Postgres uses a `window` `copy` listener (mirror MySQL/MSSQL)
Add a `useEffect` in the Postgres grid registering `window.addEventListener("copy", handleCopy)` that:
1. early-returns if a single cell is active (keydown handler owns that path),
2. early-returns if `selection.anchor`/`active` is null,
3. resolves the row range `[min, max]`, builds an edit-resolved `unknown[][]`, and writes `formatRowsTSV(...)` via `e.clipboardData.setData("text/plain", …)` + `e.preventDefault()`.
- **Why mirror the listener pattern instead of extending `onGridKeyDown`:** consistency with the two grids that already ship this, and `copy`-event + `setData` is the reliable path for multi-line clipboard writes. Effect deps mirror MySQL: `[selection, rows, activeCell, columns, buffer]`.

### Decision 3: Edit-aware value resolution per engine
The caller resolves each cell to its displayed value before formatting:
- **Postgres**: for each row reuse the single-cell logic — `buffer.getRowEdits(rowKey)`; if the column name is in `changes`, use the edited value, else the server cell.
- **MySQL/MSSQL**: per cell call the existing `buffer.getDisplayValue(rowKey, cells, columnNames, colName)` already used by their single-cell branch.
Rows without a `rowKey` (defensive) fall back to raw `cells`.
- **Why:** single-cell copy is already edit-aware; a row copy that disagreed with the visible/edited grid would be a correctness bug. This also fixes the existing MySQL/MSSQL staleness.

### Decision 4: New capability spec `grid-row-copy`
Behaviour is distinct from `grid-cell-copy` (multi-row vs single cell) but complementary. `grid-cell-copy` already documents the cell-vs-row precedence and the shared formatter, so its requirements don't change; the new behaviour lands as its own spec.

## Risks / Trade-offs

- **Two clipboard-write mechanisms coexist** (single cell → `navigator.clipboard.writeText`; row range → `copy` event `setData`) → Accept: this already exists in MySQL/MSSQL and the mutual-exclusion of the two selection modes means only one path ever fires per ⌘C.
- **Global `window` "copy" listener could fire when grid isn't focused** → Mitigation: the handler early-returns unless this grid has a non-null row-range selection and no active cell; mirrors the proven MySQL/MSSQL guard. The listener is scoped to the grid component's lifetime via the effect cleanup.
- **Stale closure over `selection`/`rows`/`buffer`** → Mitigation: effect dependency array includes all of them (matching MySQL), so the listener re-binds on change.
- **Behaviour change for MySQL/MSSQL** (now edit-aware) is intended; the TSV shape is unchanged for unedited rows, so spreadsheet paste is unaffected.
