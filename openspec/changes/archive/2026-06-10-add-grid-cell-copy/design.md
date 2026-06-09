## Context

Argus has four grid families, each implemented per-engine with no shared base:

- **Postgres** `data/DataGrid.tsx` — row-range selection `{ anchor, active }` (row indices); keyboard handler (~185-225) handles Backspace/Delete/Escape only; **no copy**. Edit entered via `EditableCell` double-click (`onStartEdit`). Read-only `AdhocResultGrid.tsx` has row click selection, **no copy, no double-click**.
- **MySQL** `data/DataGrid.tsx` — row-range **copy** via a `window` `"copy"` listener (~144-164) building TSV from `selection.anchor`/`active`; `cellToString` helper (~453-464). Edit via double-click (~356).
- **MSSQL** `data/DataGrid.tsx` — identical pattern to MySQL (~146-166, `cellToString` ~455-465).
- **Athena** `sql/ResultPanel.tsx` — a lightweight read-only `SimpleTable` (~226-275) with row selection, **no copy**.

Selection state is row-centric everywhere (`{ anchor: number|null; active: number|null }`), owned by the parent (`TableViewerTab.tsx` for Postgres; local for MySQL/MSSQL). `cellToString` is duplicated across MySQL and MSSQL. No `navigator.clipboard` usage exists in the grids today (the existing copy uses the native `ClipboardEvent` path).

This change adds a cross-cutting, UI-only capability (single-cell selection + ⌘C copy) on top of all of these without touching the Rust backend.

## Goals / Non-Goals

**Goals:**
- One uniform gesture — click a cell, press ⌘C — copies that cell's value in every grid, editable and read-only.
- A single shared helper for value→string formatting and clipboard write, eliminating the duplicated `cellToString`.
- Preserve existing row-range TSV copy where present.
- Keep double-click → edit on editable cells; keep native text copy inside open editors.

**Non-Goals:**
- No multi-cell rectangular selection or column-range copy.
- No backend/Rust changes, no new dependencies, no Tauri clipboard command.
- No change to DynamoDB / CloudWatch grids (out of issue scope; can follow later).
- No change to existing row-range copy format.

## Decisions

### Decision 1: Add an `activeCell` alongside, not replacing, row selection
Widen each grid's selection model with an optional `activeCell: { row: number; col: number } | null`, kept mutually exclusive with the row-range `{ anchor, active }`. Setting one clears the other.

- **Why:** Minimally invasive. Row-range copy (MySQL/MSSQL) and bulk delete (Postgres) already depend on `{ anchor, active }`; replacing it would ripple widely. An additive field keeps those paths intact and makes the copy target unambiguous.
- **Alternative considered:** Generalize selection to cell ranges `{ anchor:{r,c}, active:{r,c} }`. Rejected for v1 — larger refactor, and the issue only asks for single-cell copy.

### Decision 2: Single shared helper `src/lib/grid/cellClipboard.ts`
Export `formatCellValue(value): string` (the unified null/boolean/object/preview mapping) and `copyCellValue(value): Promise<void>` (format + write). MySQL/MSSQL `cellToString` is replaced by `formatCellValue`.

- **Why:** Kills duplication and guarantees identical formatting between cell copy and row-range copy across engines.
- **Alternative considered:** Per-engine copies. Rejected — that is exactly the inconsistency issue #90 calls out.

### Decision 3: Use `navigator.clipboard.writeText` for cell copy, triggered by a keydown handler
Cell copy is driven by the grid's `onKeyDown` (the grid container is focusable), detecting `(e.metaKey || e.ctrlKey) && e.key === 'c'` while `activeCell` is set and the event target is not an input/textarea/select. On match: `e.preventDefault()` and `copyCellValue(value)`.

- **Why:** A keydown handler scoped to the grid lets us reliably check "is an editor focused?" (skip if so) and "is a cell active?" before claiming the event. `navigator.clipboard.writeText` is the simplest async write and is available in the Tauri webview.
- **Interaction with existing `window` `"copy"` listener (MySQL/MSSQL):** keep it for row-range, but it MUST early-return when `activeCell` is set so the keydown path owns single-cell copy. Equivalent alternative: route row-range copy through the same keydown handler too; either is acceptable as long as precedence (Decision in spec) holds.
- **Alternative considered:** Handle everything in the `window` `"copy"` event via `clipboardData.setData`. Workable but harder to scope focus checks and not present in Postgres/read-only grids at all.

### Decision 4: Double-click unchanged; do not intercept copy inside editors
Keep `onDoubleClick → onStartEdit` on editable cells. The keydown copy handler bails when the event target is a form field, so native text selection copy inside an open editor keeps working (validate this — issue notes it "should work today").

- **Why:** Avoids regressing inline editing while satisfying the issue's "select text in input and ⌘C" path.

### Decision 5: Read-only grids get selection + copy too
`AdhocResultGrid` (Postgres) and Athena `SimpleTable` gain `activeCell` state and the same keydown copy handler. They do not gain edit mode.

- **Why:** The acceptance criterion explicitly requires copy in read-only/ad-hoc result grids.

## Risks / Trade-offs

- **Focus management:** ⌘C only fires on the grid handler if the grid container is focusable/focused. → Ensure the scroll container has `tabIndex={0}` and receives focus on cell click; fall back gracefully (no crash) if not focused.
- **`navigator.clipboard` requires a secure/permitted context:** the Tauri webview qualifies, but writes can reject. → `copyCellValue` swallows/logs rejection without throwing into React render; optional brief "Copied" affordance is best-effort.
- **Double-binding copy (window "copy" + keydown):** risk of copying twice or wrong target. → The window listener early-returns when `activeCell` is set; the keydown handler `preventDefault()`s. Covered by the precedence scenarios in the spec.
- **Per-engine duplication remains for grids themselves:** we only share the clipboard helper, not the grids. → Acceptable for v1; consistent formatting is the key win.

## Migration Plan

Pure additive UI change, no data or API migration. Ship behind no flag. Rollback = revert the diff; no persisted state changes.

## Open Questions

- Should a transient "Copied" toast/affordance be shown on cell copy, or stay silent like the current row-range copy? (Lean: silent for parity; affordance optional.)
- Confirm via QA that ⌘C inside an open editor already copies selected input text in the Tauri webview (issue asks to validate).
