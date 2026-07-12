## Context

The three editable SQL grids (Postgres, MySQL, MSSQL) already support row-range copy: pressing ⌘C/Ctrl+C with a row range selected writes the rows to the clipboard as TSV. That path was deliberately moved off the browser's native `copy` event into the grid's own `onKeyDown` handler because WKWebView does not dispatch native clipboard events for CSS-only (non-DOM) row selections (issue #213). There is **no paste counterpart** — #243 asks for ⌘V to duplicate the selected rows as new records.

Relevant current state (all under `packages/app/src/`):

- **Three parallel grids** (not one shared component): `modules/{postgres,mysql,mssql}/data/DataGrid.tsx`. Each owns `onGridKeyDown` (the ⌘C / ⌘A / Delete / Escape handler) and guards against native-editable targets (`INPUT`/`TEXTAREA`/`SELECT`/`contentEditable`) and open editors (`editing`).
- **Three parallel parents**: `modules/{postgres,mysql,mssql}/data/TableViewerTab.tsx`. Each owns `selection` (row range `{anchor, active}`) and `activeCell` (single cell), which are **mutually exclusive**. Each has `onAddRow()` → `buffer.addInsertRow({})` → selects the new top row → scrolls to top.
- **Three parallel buffers**: `modules/{engine}/data/useEditBuffer.ts`. `addInsertRow(values?)` mints a `tmp:*` key and creates a `{ kind: "insert", pk: {}, changes: values }` entry. Pending inserts render at the top of `unifiedRows` (built in `TableViewerTab`, cells = `changes[col.name] ?? null`). `toEditOps()` → `applyTableEdits` → per-engine `*_apply_table_edits` Rust command; columns omitted from an insert's `values` fall through to the database default.
- **Shared clipboard/format helpers**: `platform/clipboard/index.ts` (`writeClipboardText`, `COPY_FAILED_MESSAGE`), `platform/grid/gridCopy.ts` (`copyRowRangeFromKeydown(e, deps)` — the testable, DOM-event-structural row-copy helper), `platform/grid/cellClipboard.ts` (`formatCellValue`, `formatRowsTSV`).
- **Row resolution differs per engine**: Postgres resolves cells positionally; MySQL/MSSQL go through `buffer.getDisplayValue`. The paste path does **not** need row resolution (it writes, not reads), so this asymmetry does not affect it.

## Goals / Non-Goals

**Goals:**

- ⌘V/Ctrl+V with a row range selected (no active cell, not editing) appends one pending **insert** row per clipboard TSV line to all three editable grids.
- A copy-then-paste round-trip reproduces the source rows' editable values, positionally mapped column-for-column.
- Duplicating a row whose PK is auto-generated (SERIAL/identity/auto-increment) yields a fresh key on Save — the paste must not force the source PK.
- Reuse the existing pending-insert Save flow with **zero backend changes**.
- Mirror the copy path's guards (edit-mode / native-input / selection-model) and its toast-based failure surfacing.
- Share the parse + guard logic across the three engines instead of triplicating it, matching how copy is shared via `gridCopy.ts`.

**Non-Goals:**

- No paste into the read-only ad-hoc SQL result grid (`AdhocResultGrid`) or the non-editable engines (DynamoDB, Athena, CloudWatch) — those have no insert buffer.
- No overwrite-in-place paste (pasting onto existing rows to update them); paste always **inserts** new pending rows.
- No paste from external spreadsheets guaranteeing perfect type fidelity — pasted cells enter the insert buffer as the same string representation a user typing into a new-row cell produces, and rely on the existing apply-path coercion.
- No new keyboard chord, menu item, or context-menu entry beyond ⌘V/Ctrl+V (a context-menu "Paste rows" entry can follow later).
- No smart NULL vs empty-string disambiguation (see Risks).

## Decisions

### Decision 1: A shared `pasteRowRangeFromKeydown` helper, mirroring `copyRowRangeFromKeydown`

Add `platform/grid/gridPaste.ts` exporting:

- `parseTsvRows(text: string): string[][]` — split on `\n`, strip a trailing `\r` per line, drop a single trailing empty line, split each line on `\t`. Pure and unit-testable; the inverse of `formatRowsTSV`.
- `pasteRowRangeFromKeydown(e, deps): Promise<boolean>` — structurally identical guard/return contract to `copyRowRangeFromKeydown`: returns `false` (declines, caller falls through to native paste) when `editing`, the target is a native-editable element, `activeCell !== null`, or the selection is empty; otherwise `e.preventDefault()`, reads the clipboard, parses, maps to per-column values, and invokes `deps.onPasteRows(valuesList)`.

`deps` shape:

```
{
  editing: boolean;
  activeCell: unknown | null;
  selection: { anchor: number | null; active: number | null };
  columns: { name: string }[];       // display order
  pkColumns: string[] | null;        // columns to omit from pasted values
  read: () => Promise<string | null>; // navigator.clipboard.readText wrapper
  onPasteRows: (rows: Record<string, EditValue>[]) => void;
  onError?: (message: string) => void;
}
```

**Why**: copy already proved that a structural, DOM-agnostic keydown helper is testable and keeps the three grids in lockstep. Paste gets the same treatment so the guard logic (the subtle part — edit mode, native inputs, WKWebView, selection mutual-exclusion) lives in exactly one place. *Alternative considered*: inline the logic in each `onGridKeyDown` — rejected because it would triplicate the guards and drift, exactly the problem #213's refactor solved for copy.

### Decision 2: Read the clipboard programmatically via a new `readClipboardText`

Add `readClipboardText(): Promise<string | null>` and a `PASTE_FAILED_MESSAGE` to `platform/clipboard/index.ts`, parallel to `writeClipboardText`. Returns `null` on `navigator.clipboard.readText()` failure (logged as a warning), so the helper can surface a toast.

**Why**: symmetry with the write path, and the same WKWebView reasoning — do the clipboard I/O explicitly in the keydown handler rather than relying on a native `paste` event that WebKit won't fire for a CSS-only row selection. *Alternative considered*: a window-level `paste` listener — rejected for the same reason copy abandoned the `copy` event (#213).

### Decision 3: Positional column mapping, omitting primary-key columns

Copy serializes **all** cells in column order. Paste maps `parsedRow[i]` → `columns[i].name` positionally (the inverse), **skipping any column in `pkColumns`** so the pasted values never carry the source PK. Omitted columns fall through to the database default on Save (the insert `EditOp` contract), so an auto-generated key is regenerated — satisfying the headline "duplicate a row and get a fresh id" use case from #243.

- Short line (fewer cells than columns): trailing columns left unset → DB defaults fire.
- Long line (more cells than columns): extra trailing cells ignored.
- Empty cell (`\t\t`): mapped to `null` (NULL-equivalent), matching how `formatCellValue` serialized `NULL` → `""`.

**Why omit PK**: the issue is explicitly about *duplicating* rows; forcing the source PK would either collide (unique violation) or, for identity columns, be rejected. Omitting the PK is the one rule that makes the common case (SERIAL/identity) work with no user action. *Alternative considered*: paste every column verbatim and let the user delete the PK — rejected as poor UX for the primary case. *Alternative considered*: omit any column with a known default — rejected because the frontend does not reliably know non-PK defaults; PK omission is the minimal correct rule (natural-PK tables are handled per Risks).

### Decision 4: Insert-and-select happens in each `TableViewerTab`, not the grid

The grid calls up via `onPasteRows`; each `TableViewerTab` implements it by looping `buffer.addInsertRow(values)` per parsed row, then selecting the pasted range at the top and scrolling to top — reusing the exact sequence `onAddRow` already uses.

**Why**: `selection`, `activeCell`, buffer mutation, and `gridRef.scrollToTop()` all live in the parent today; keeping paste's side effects there mirrors `onAddRow` and avoids handing the grid new responsibilities. *Alternative considered*: have the grid call `buffer.addInsertRow` directly (it does hold `buffer`) — rejected because selection/scroll orchestration would still need a parent callback, so a single `onPasteRows` callback is cleaner.

### Decision 5: Pasted values stored as strings, coerced by the existing apply path

Pasted cell values enter `changes` as strings (the same representation a user typing into a freshly-added insert row's cell produces), and are persisted through the unchanged per-engine `build_edit_sql` / `*_apply_table_edits` coercion. No backend change.

**Why**: the manual add-row path already round-trips these representations through the apply command; reusing it guarantees paste behaves identically to hand-entering the same values and keeps the change frontend-only.

## Risks / Trade-offs

- **NULL vs empty-string ambiguity** → `formatCellValue` maps both SQL `NULL` and an empty string to `""`, so paste cannot distinguish them and treats every empty cell as `NULL`. Mitigation: documented behavior; matches spec scenario "Empty TSV cell maps to NULL-equivalent"; the user can edit the pending cell before Save. Acceptable for a duplicate-rows workflow.
- **Natural (non-auto) primary keys** → omitting the PK means a table with a user-assigned PK and no default produces an insert missing its PK, which fails on Save with a validation/DB error surfaced in the existing op-failed banner. Mitigation: the pending row is editable — the user fills the PK before saving; the banner already communicates the failure. This is the correct trade to make the far-more-common SERIAL/identity case work automatically.
- **Non-PK defaulted columns copied verbatim** → columns like `created_at DEFAULT now()` are pasted with the source value rather than re-defaulting. Mitigation: user can clear the cell; out of scope to detect arbitrary defaults client-side.
- **Type-strict columns from external paste** → TSV pasted from an external spreadsheet may carry values the target column can't accept. Mitigation: same coercion and op-failed surfacing as manual entry; no new failure mode versus hand-typing.
- **Three-way drift** → the parse/guard logic is shared in `gridPaste.ts`, but each grid must wire the ⌘V branch and each `TableViewerTab` must wire `onPasteRows`. Mitigation: keep all logic in the shared helper; the per-engine wiring is a thin, near-identical call, and the tasks add tests at the shared-helper level.
- **`onGridKeyDown` is currently synchronous-ish** → the copy branch is already `async` (fire-and-forget). Paste follows the same pattern; `e.preventDefault()` is called synchronously inside the helper before the awaited clipboard read so the native paste is reliably suppressed.

## Open Questions

- Should a "Paste rows" entry be added to the row context menu (`RowContextMenu.tsx`) for discoverability, or is the ⌘V shortcut sufficient for v1? (Leaning: shortcut-only for v1, matching the issue; context-menu entry as a fast follow.)
