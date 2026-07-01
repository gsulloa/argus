## Why

Row-range copy (`⌘C` on one or more selected rows, shipped in #196) does not work in the released desktop app (issue #213, v0.7.3). Row-range copy is implemented via a window-level native `copy` clipboard event, but in the macOS WKWebView that Tauri uses, the `copy` event does **not** fire when there is no native DOM text selection — and the grid's row selection is only a visual/React-state highlight, not a DOM `Selection`. As a result `⌘C` over selected rows silently copies nothing. Single-cell copy is unaffected because it is handled in the grid's `onKeyDown` handler with an explicit `navigator.clipboard.writeText`, which is exactly the path row copy must adopt.

This change is delivered in **two sequenced commits inside one PR**, with a manual packaged-app verification gate between them (the keydown `⌘C` path firing in WKWebView with a CSS-only row selection is the one assumption we must prove before expanding blast radius):

**Commit 1 — the fix (verify before proceeding):**
- Move row-range `⌘C`/`Ctrl+C` handling out of the fragile window-level native `copy` event and into the grid's `onKeyDown` handler (the same handler that already powers single-cell copy), writing via `navigator.clipboard.writeText` so it works inside the Tauri/WKWebView environment.
- Extract a shared, UI-agnostic helper (`copyRowRangeFromKeydown`) in `platform/grid/` that takes an injected per-row value resolver (Postgres resolves positionally; MySQL/MSSQL via `buffer.getDisplayValue`). All three grids call it; the `window` `copy` listener is removed from all three.
- Preserve all existing semantics: single-cell vs row-range are mutually exclusive (active cell takes precedence), pending in-buffer edits are reflected, TSV formatting via the shared formatter, no interception while a cell is in edit mode.
- Full unit coverage of the helper (6 branches) + one grid-level Postgres integration test.

**Commit 2 — row-number gutter → single-row selection (the other half of #213):**
- The clipboard mechanism alone doesn't satisfy the report: a plain click selects a *cell* (`activeCell`), and a row range only forms on a mouse drag (≥4px) or ⌘A, so there is no way to select **one** row by clicking — which "estilo TablePlus" requires.
- Add a left **row-number gutter** and make it clickable: click a gutter cell selects that whole row (clears the active cell), shift-click extends the range, and (Postgres) drag on the gutter selects a range.
- Postgres has no gutter today — add one (header corner + per-row number cell with `+`/`−` insert/delete markers, matching MySQL/MSSQL). MySQL/MSSQL already render a 32px row-number gutter — just wire its click/shift-click + hover affordance.
- Clicking the gutter focuses the grid root so ⌘C copies the selected row immediately.

**Commit 3 — consolidation + feedback (after verification):**
- Consolidate all three copy paths (single-cell, row-range, context-menu) into one grid-clipboard module so every copy behavior lives in one tested place.
- Surface clipboard-write failures for grid copy via the existing `useToast().show(msg, "error")` primitive instead of the current silent `console.warn` swallow (failure-only, non-blocking; never on success).
- Apply across all three editable grids (Postgres, MySQL, MSSQL) so parity is maintained.

Deferred to a follow-up (tracked in a GitHub issue): extending copy-failure feedback to the ~10 non-grid copy sites (DDL, ARN, SQL history, chat code, updater logs) for app-wide consistency.

## Capabilities

### New Capabilities

- `grid-row-selection`: Selecting whole rows in the editable data grids via a clickable row-number gutter (click = single row, shift-click = range, drag = range on Postgres), so a single row can be selected without dragging — the precondition for copying one row with ⌘C.

### Modified Capabilities

- `grid-row-copy`: (1) The "Copy selected row range as TSV with Cmd+C" requirement is clarified to mandate that row-range copy is triggered through the grid's keyboard handler (not a native browser `copy` event), so it functions in the desktop WKWebView where no DOM text selection backs a row selection. (2) A new requirement is added: grid copy failures are surfaced to the user (error toast) rather than silently swallowed.

## Impact

- **Code**: `packages/app/src/modules/postgres/data/DataGrid.tsx` and the MySQL/MSSQL grid equivalents — remove the `window.addEventListener("copy", …)` effect; route all copy paths through the shared grid-clipboard module.
- **New shared module**: `packages/app/src/platform/grid/` gains `copyRowRangeFromKeydown` (and, in commit 2, the consolidated copy-path entry points). Reuses existing `copyRowsTsv` / `formatRowsTSV` / `copyCellValue`; the write helpers gain a way to report failure to the caller (return/throw) so the grid can toast.
- **Toast**: uses the existing `platform/toast` `useToast().show` API; no new dependency.
- **No API, DB, or new-dependency changes.** Behaviour-only fix; user-visible effect is that `⌘C` now copies selected rows as it always should have, and copy failures are now visible.
