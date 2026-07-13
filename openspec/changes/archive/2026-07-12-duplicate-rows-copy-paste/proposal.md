## Why

Users can already select rows and copy them to the clipboard (`grid-row-copy`), but there is no way to **paste** those rows back into the grid to duplicate them. In-app feedback (#243) reports that Cmd/Ctrl+C followed by Cmd/Ctrl+V does not duplicate rows. Duplicating an existing row as a starting point for a new record is a common data-editing workflow, and the copy half already exists — only the paste half is missing.

## What Changes

- Add a **paste-to-insert** path to the three editable data grids (Postgres, MySQL, MSSQL): with one or more rows selected (a row range, no active single cell), Cmd/Ctrl+V parses TSV clipboard content and appends new **pending insert rows** to the grid — one per clipboard line — pre-filled with the pasted cell values, awaiting the user's normal Save action.
- Pasted values are mapped to grid columns **by position** (column order), the inverse of the shared row-TSV formatter used by copy, so a copy-then-paste round-trip reproduces the source rows' values.
- Auto-generated / default-backed columns (e.g. `SERIAL`/identity primary keys) are **not** forced from the pasted values: the paste produces the same kind of pending insert row the "add row" affordance already creates, so database defaults still fire on Save and duplicated rows get fresh keys.
- Paste is **mutually exclusive** with in-editor paste (never intercepted while a cell is in edit mode) and only fires on a row-range selection, mirroring the copy path's guards.
- Paste failures (malformed clipboard, empty clipboard, read error) are surfaced via the app toast primitive rather than silently swallowed, consistent with `grid-row-copy`'s failure handling.

## Capabilities

### New Capabilities

- `grid-row-paste`: Pasting TSV clipboard content into an editable data grid (Postgres, MySQL, MSSQL) with Cmd/Ctrl+V to create new pending insert rows, positionally mapping clipboard columns to grid columns, reusing the existing pending-insert Save flow, guarded to fire only on a row-range selection and never inside an open cell editor, with failures surfaced as toasts.

### Modified Capabilities

<!-- No existing spec-level requirements change. The per-engine data-edit specs
     (postgres-data-edit / mysql-data-edit / mssql-data-edit) already define the
     insert payload and apply flow this change reuses unchanged. -->

## Impact

- **Frontend**: the shared editable data-grid component and its keyboard handler (the same handler that owns single-cell copy and row-range copy), plus a shared TSV→rows parser that inverts the existing row-TSV formatter, and the pending-insert-row state the grid already maintains.
- **Backend**: none. Pasted rows persist through the existing per-engine `insert` `EditOp` and apply commands (`postgres_apply_table_edits` and its MySQL/MSSQL equivalents) with no changes.
- **Related issues**: #196 / #213 (copy rows to clipboard as text) are the copy counterpart; this change is the paste/insert counterpart and depends on the same TSV format.
