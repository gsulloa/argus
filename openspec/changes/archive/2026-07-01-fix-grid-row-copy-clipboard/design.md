## Context

Row-range copy shipped in #196 for the three editable grids (Postgres, MySQL, MSSQL). Each grid registers a **window-level `copy` event listener** that, when a row range is selected and no single cell is active, serializes the range to TSV via `e.clipboardData.setData("text/plain", …)` and calls `e.preventDefault()`.

Issue #213 (v0.7.3) reports that selecting one or more rows and pressing ⌘C copies nothing in the packaged app.

Root cause: the native `copy` clipboard event only fires when the browser/webview has something it considers copyable — typically a non-collapsed DOM `Selection` or a focused editable element. The grid's row selection is **React state plus CSS highlighting**, not a DOM text selection. In macOS WKWebView (Tauri's webview), pressing ⌘C with no DOM selection does **not** dispatch a `copy` event, so `handleCopy` never runs and nothing is written.

Single-cell copy is unaffected because it lives in the grid root's `onKeyDown` handler and writes with `navigator.clipboard.writeText` (`copyCellValue`). `navigator.clipboard.writeText` is used by ~10 shipping features in this app (copy DDL, ARN, SQL history, chat code, updater logs), including the keydown-triggered single-cell copy — strong evidence the fix mechanism works in the packaged WKWebView. The context-menu "Copy row(s)" action also works because it calls `copyRowsTsv` (also `navigator.clipboard.writeText`). Only the keyboard row-copy path is broken, because it alone depends on the native `copy` event.

Relevant code (all three grids mirror this shape):
- `packages/app/src/modules/postgres/data/DataGrid.tsx:278-301` — window `copy` effect (to remove)
- `packages/app/src/modules/postgres/data/DataGrid.tsx:307-327` — `onGridKeyDown`, single-cell copy branch (to extend)
- `packages/app/src/modules/mysql/data/DataGrid.tsx:186` and `packages/app/src/modules/mssql/data/DataGrid.tsx:188` — same window `copy` effects
- `packages/app/src/platform/grid/cellClipboard.ts` — `copyRowsTsv`, `formatRowsTSV`, `copyCellValue`, `resolveCellDisplayValue`
- `packages/app/src/platform/toast` — `useToast().show(message, "error")` (existing toast primitive)

```
BEFORE (broken)                          AFTER (commit 1)
─────────────────                        ─────────────────
window "copy" event ──X (never fires     grid onKeyDown ──► copyRowRangeFromKeydown(e, {
  in WKWebview w/o                          selection, activeCell, editing, rangeStart/End,
  DOM selection)                            resolveRow, columnNames, write, onError })
  └► setData + preventDefault                │
                                             ├─ editing / native-editable target → return (native copy)
                                             ├─ activeCell set → return (single-cell path owns it)
                                             ├─ selection null → return (no-op, no toast)
                                             └─ row range → rows = resolveRow(i)  → write(TSV)
                                                                                    └─ fail → onError → toast
```

## Goals / Non-Goals

**Goals:**
- ⌘C / Ctrl+C copies the selected row range as TSV in the packaged desktop app.
- Preserve every existing semantic: active-cell precedence, mutual exclusivity, pending in-buffer edits reflected, TSV format identical, no interception in edit mode.
- One shared, tested place for grid copy behavior across Postgres, MySQL, MSSQL.
- Grid copy failures are visible, not silently swallowed.

**Non-Goals:**
- No change to the TSV format or the shared value formatter.
- No new header-row-in-TSV feature (the `columns` arg to `copyRowsTsv` stays reserved).
- No app-wide copy-failure feedback beyond the grid (deferred to a follow-up issue).
- No change to column ordering / selection semantics — the helper consumes the same displayed `rows`/`columns` arrays the working context-menu copy already uses.

## Decisions

**D1 — Sequence the work in two commits inside one PR, with a verification gate.**

The keydown Cmd+C path firing in packaged WKWebView with a CSS-only row selection is assumed, not yet proven (single-cell keydown copy is strong but not identical evidence). So:
- **Commit 1** lands the core fix (row-range copy → `onGridKeyDown` via the shared helper) + tests, then we **manually verify in the packaged app** (build, select rows, ⌘C, paste).
- **Commit 2** lands the full copy-path consolidation + failure toast, only after commit 1 is confirmed working.

Rationale: make the change easy, then make the easy change (Beck); keep the cost of being wrong low by proving the mechanism before expanding blast radius across three grids. *Alternative — do it all at once:* rejected on the outside voice's blast-radius argument; if the keydown path had a surprise in WKWebView, a single big commit would be harder to bisect.

**D2 — Extract a shared, UI-agnostic helper `copyRowRangeFromKeydown`.**

The copy logic is triplicated today (window-copy listener, single-cell copy, context-menu copy all appear 3×). Engines differ in row-value resolution (Postgres positional `resolveCellDisplayValue` vs MySQL/MSSQL `buffer.getDisplayValue(rowKey, cells, columnNames, colName)`), so the helper takes an **injected `resolveRow(index) => unknown[]`** callback rather than being a pure copy-paste unification.

Keep the helper thin and layered (per the outside voice) — it decides and delegates, it does not own UI or formatting:
1. decide: is this a copy shortcut? is the target a native editable / is `editing` true? is a single cell active? is a row range present?
2. derive: resolve the selected rows via the injected resolver
3. delegate formatting to existing `formatRowsTSV`
4. write via injected `write(tsv)` (wraps `navigator.clipboard`), and call injected `onError(message)` on failure

This keeps the helper pure enough to unit-test all branches with a fake resolver + fake writer, no DOM.

**D3 — Consolidate all three copy paths into one grid-clipboard module (commit 2).**

Single-cell copy and context-menu copy are also triplicated. Fold them into the same module so every grid copy behavior lives in one tested place. The three grids keep only their engine-specific `resolveRow`/`columnNames` wiring.

**D4 — Surface copy failures via the existing toast (commit 2).**

Today `copyRowsTsv`/`copyCellValue` swallow write errors (`console.warn`). Change the write helpers to report failure (return a boolean or throw); the grid passes `onError = (msg) => toast.show(msg, "error")`. Failure-only, non-blocking, never on success, never on a no-op (nothing selected). Toast stays out of the pure helper — it is injected — so tests stay DOM-free.

**D5 — Active-cell precedence is safe because the two modes are mutually exclusive.**

The outside voice worried that an active cell coexisting with a row range would preserve the bug. In these grids they cannot coexist: marking an active cell clears the row range (`DataGrid.tsx:426`) and starting a row range clears the active cell (`:421`), per the `grid-cell-copy` spec. Order in the helper: `editing`/native-editable first, then `activeCell` (single-cell path), then row range. This is verified, not assumed.

## Risks / Trade-offs

- **[Keydown Cmd+C may not fire in WKWebView with CSS-only selection]** → Mitigated by D1's verification gate: commit 1 is proven in the packaged app before commit 2. Counter-evidence: single-cell keydown copy already uses this exact activation path. If it fails, fallback is the Tauri clipboard plugin (`@tauri-apps/plugin-clipboard-manager`) — noted, not adopted.
- **[jsdom tests can't reproduce the WKWebView copy-event bug]** → Unit/integration tests lock in the new *logic* and prevent future logic regressions; the *environment* regression guard is the manual packaged-app check (task 4.x, written as a precise repeatable script). Stated honestly, not papered over.
- **[Toast noise]** → Failure-only + non-blocking + the existing toast's auto-dismiss. No toast on success or on empty-selection no-op.
- **[Consolidation blast radius across 3 grids]** → Contained by D1 (lands second, after the fix is proven) and by full test coverage before commit 2.
- **[`if (editing) return` means open-editor text does not copy as a row]** → Intentional: an open cell editor uses native text copy. Committed-but-unsaved buffer edits still copy via the resolver. Made explicit and tested.

## D6 — Row-number gutter for single-row selection (Commit 2)

The clipboard fix (Commit 1) is necessary but not sufficient: a plain click selects a *cell*, and a row range only forms via drag (≥4px) or ⌘A, so there is no way to select **one** row by clicking. Add a clickable row-number gutter.

Asymmetry across engines (verified by reading the render code):
- **MySQL / MSSQL** already render a 32px left gutter cell showing `rowIdx + 1` (with `+`/`−` insert/delete markers) — `mysql/data/DataGrid.tsx:478-498`, header corner at `:272`. It is **not** clickable. Change: add `onClick`/shift-click to that cell (select row / extend range), a `cursor:pointer` + hover, and focus the grid root so ⌘C works. These grids select via `onCellClick` + shift (no drag), so the gutter mirrors that model.
- **Postgres** has **no** gutter. Add one: a 32px header corner + a per-row gutter cell (`vi.index + 1`, `+`/`−` markers, `--text-subtle`, tabular-nums, right-aligned) as the first flex child of `.headerRow` and `.row`; widen `thead`/`.body`/status-row from `totalWidth` to `totalWidth + 32`. Postgres selects via drag machinery, so the gutter `onMouseDown` reuses it.

```
GUTTER  COLUMNS ─────────────────►
┌────┬──────────┬──────────┐
│  # │ id       │ name     │   ← header corner (empty) + column headers
├────┼──────────┼──────────┤
│  1 │ 1        │ row-0    │   click gutter → select row 1 (clears active cell)
│ ▓2 │ 2        │ row-1    │   shift-click gutter row 4 → rows 2..4
│ ▓3 │ 3        │ row-2    │
│ ▓4 │ 4        │ row-3    │
└────┴──────────┴──────────┘   then ⌘C → 3 TSV lines
```

Postgres gutter `onMouseDown` (primary button): `e.preventDefault(); e.stopPropagation()` (so the row's own drag `onMouseDown` does not also fire); if `shiftKey && selection.anchor !== null` → `onSelectionChange({anchor: selection.anchor, active: idx})` + `onActiveCellChange(null)`; else `onActiveCellChange(null)` + `onSelectionChange({anchor: idx, active: idx})` and start the drag in `status:"active"` (anchorColIndex 0) via `dragRef`/`setDragActive(true)` so drag extends the range and `handleMouseUp` finalizes it (never the click→cell branch). `handleMouseUp` already focuses the grid root.

MySQL/MSSQL gutter `onClick`: shift+anchor → extend; else `setActiveCell(null)` + `onSelectionChange({anchor: idx, active: idx})`; then focus the grid root (`e.currentTarget.closest('[tabindex]')`) so ⌘C works.

Non-goals: no sparse (Cmd+click) multi-select — the anchor/active model is contiguous only; no sticky-left gutter in v1 (matches the existing MySQL/MSSQL non-sticky gutter); gutter width stays 32px for parity.

## Migration Plan

Pure behavioral fix; no data or API migration. Two commits, one PR. Rollback is a straight revert of the PR (or just commit 2 if the fix holds but consolidation regresses). Ships in the next release.

## Open Questions

- None blocking. If packaged-app verification (D1) fails, escalate to the Tauri clipboard plugin fallback before commit 2.
