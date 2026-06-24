## Context

The Postgres, MySQL, and MSSQL data grids share a forked `DataGrid.tsx` that tracks two mutually-exclusive selection modes:

- `selection: { anchor: number | null; active: number | null }` — an inclusive row range; `anchor === null` means no row selection.
- `activeCell: { row: number; col: number } | null` — a single active cell; mutually exclusive with the row range.

The grid root is `tabIndex={0}` and owns an `onGridKeyDown` handler (`DataGrid.tsx` ~line 193) that already implements:
- `Cmd/Ctrl+C` — copy active cell (guarded against native editing contexts).
- `Backspace/Delete` — bulk-delete selected row range.
- `Escape` — clear active cell, then clear row range.

Selection changes are pushed up via `onSelectionChange(...)` and `onActiveCellChange(...)` callbacks; the actual state lives in each engine's `TableViewerTab` (or equivalent) and resets on sort/filter/page changes. There is no `Cmd+A` handling today, so the keystroke reaches the browser and selects all visible application text.

This change adds a `Cmd+A` branch to the same `onGridKeyDown` handler in all three forks. No backend, persistence, or new state is involved.

## Goals / Non-Goals

**Goals:**
- `Cmd+A` / `Ctrl+A` selects all currently-loaded rows when the grid is focused and a selection (cell or row range) is already active.
- The shortcut prevents the browser default only when it actually acts; otherwise native select-all is untouched.
- Identical behavior across Postgres, MySQL, and MSSQL grids.
- Reuse the existing selection model and callbacks — no new state, no new design tokens.

**Non-Goals:**
- DynamoDB's Set-based selection model (`dynamo/data-view/TabView.tsx`) — separate model, not addressed.
- Read-only result grids without row-range selection (Athena `SimpleTable`, `AdhocResultGrid`).
- Loading/counting additional rows so "all" means the full server-side table. "All rows" means all rows **currently loaded** in the grid (consistent with how row-range drag-select, bulk delete, and the bottom-bar count already behave).
- Cmd-click / Shift-click multi-range extension (already explicitly out of scope in the row-range capability).

## Decisions

1. **Place the handler in `onGridKeyDown`, before the `Escape` branch.** This is the same focus-gated surface used by `Cmd+C` and bulk-delete, so the grid-focus guarantee (root has `tabIndex={0}` and receives focus) already holds.

2. **Gate on an existing selection.** The branch only acts when `selection.anchor !== null || activeCell !== null`. This matches the issue ("cuando hay una selección activa") and is what lets normal text select-all keep working everywhere the user hasn't engaged the grid.

   ```ts
   if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
     // Respect native editing contexts (input/textarea/select/contentEditable),
     // mirroring the existing Cmd+C guard.
     if (isEditableTarget(e.target)) return;
     const hasSelection = selection.anchor !== null || activeCell !== null;
     if (!hasSelection || rows.length === 0) return; // let native select-all through
     e.preventDefault();
     onActiveCellChange(null);                       // mutually exclusive
     onSelectionChange({ anchor: 0, active: rows.length - 1 });
     return;
   }
   ```

3. **Reuse the same editable-target guard as `Cmd+C`.** The existing copy handler already checks for `INPUT`/`TEXTAREA`/`SELECT`/contentEditable to avoid hijacking native editing. The `Cmd+A` branch reuses that exact check so select-all-text inside an open cell editor is never overridden.

4. **Collapse `activeCell` into the row range.** Selecting all rows is a row-range operation; per the mutual-exclusivity invariant, `onActiveCellChange(null)` is called before setting the full range, exactly as the row-range path elsewhere does.

5. **Apply the identical edit to all three forks.** Because `mysql/data/DataGrid.tsx` and `mssql/data/DataGrid.tsx` are deliberate forks of the Postgres handler, the same branch is added verbatim (adjusting only any local variable names) to keep them in sync.

## Risks / Trade-offs

- **"All rows" = loaded rows, not the entire table.** With tail pagination, a very large table may not be fully loaded, so `Cmd+A` selects only what's loaded. This is consistent with existing selection/delete semantics and avoids a surprising, expensive full fetch. Accepted; documented in Non-Goals.
- **Three forked edits can drift.** Mitigated by applying byte-identical logic and adding a scenario-backed spec; a future refactor could lift the handler into a shared hook, but that is out of scope here.
- **Key matching.** Some keyboards/IMEs may report `"A"` when a modifier is held; the guard matches both `"a"` and `"A"` to be safe, mirroring tolerant key checks elsewhere.
