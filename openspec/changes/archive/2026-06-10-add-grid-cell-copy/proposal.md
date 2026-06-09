## Why

Users cannot copy the value of a single cell (e.g. an `id`) from the data grids. The expected gesture — click/double-click a cell, then ⌘C — either does nothing (Postgres, Athena, ad-hoc result grids) or copies a whole row as TSV (MySQL, MSSQL), because today selection is row-level only and double-click drops straight into edit mode. This blocks the most common day-to-day action (grab one id/value and paste it elsewhere) and the behaviour is inconsistent across engines. (GitHub issue #90)

## What Changes

- Introduce **single-cell selection** in every data grid: a single click marks the active cell (`{ row, col }`) with a visible focus ring, distinct from the existing row-range selection.
- **⌘C / Ctrl+C on a selected cell copies that cell's value** to the system clipboard as plain text, using the same value→string formatting already used for TSV row copy (null → empty string, boolean → `true`/`false`, objects → JSON).
- Make the behaviour **uniform across Postgres, MySQL, MSSQL, and Athena**, and across **editable and read-only grids** (`AdhocResultGrid`, Athena `SimpleTable`).
- Preserve the existing **row-range copy** (multi-row TSV) where it exists; cell copy takes precedence only when a single cell is the active selection.
- While a cell is in **edit mode**, ⌘C copies the selected text inside the editor input (native browser behaviour) — validate and do not intercept it.
- Add a small **shared clipboard/value-formatting helper** so the four engines stop duplicating `cellToString` and the copy handler.

## Capabilities

### New Capabilities
- `grid-cell-copy`: Single-cell selection and clipboard-copy behaviour shared across all data grids (editable and read-only) — active-cell model, ⌘C/Ctrl+C copy semantics, value→string formatting, precedence vs. row-range copy, and read-only grid support.

### Modified Capabilities
<!-- No existing spec's requirements change; the new capability layers cell copy on top of the existing per-engine grids. -->

## Impact

- **Frontend (TS/React):**
  - `src/modules/postgres/data/DataGrid.tsx`, `EditableCell.tsx`, `AdhocResultGrid.tsx`, `TableViewerTab.tsx`
  - `src/modules/mysql/data/DataGrid.tsx`, `EditableCell.tsx`
  - `src/modules/mssql/data/DataGrid.tsx`, `EditableCell.tsx`
  - `src/modules/athena/sql/ResultPanel.tsx` (`SimpleTable`)
  - New shared util (e.g. `src/lib/grid/cellClipboard.ts`) for value→string + clipboard write.
- **Selection state shape** widens from row indices to optionally track an active cell `{ row, col }`; existing row-range selection is retained.
- No backend (Rust) changes, no new dependencies, no schema or API changes.
- Uses `navigator.clipboard.writeText` (or the existing native `copy` event path) — no Tauri clipboard command required.
