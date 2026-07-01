> Delivered as two sequenced commits in one PR. Do NOT start Commit 2 until Commit 1
> is verified in the packaged app (task 2.1).

## 1. Commit 1 — shared helper + row-range keydown fix

- [x] 1.1 Add `copyRowRangeFromKeydown` to `packages/app/src/platform/grid/` (new file). Signature takes the key event plus injected deps: `{ selection, activeCell, editing, rangeStart, rangeEnd, columnNames, resolveRow: (i) => unknown[], write: (tsv) => Promise<boolean>, onError?: (msg) => void }`. Logic order: if `editing` or target is `INPUT`/`TEXTAREA`/`SELECT`/`contentEditable` → return false (native copy); if `activeCell !== null` → return false (single-cell path owns it); if `selection.anchor`/`active` null → return false (no-op, no toast); else resolve rows over `[rangeStart, rangeEnd]`, `formatRowsTSV`, `write`, `preventDefault`, and `onError` on write failure. Keep it DOM-free except reading `e.target`/`e.preventDefault`.
- [x] 1.2 Postgres `DataGrid.tsx`: call `copyRowRangeFromKeydown` from the `⌘C` branch of `onGridKeyDown`, passing `resolveRow = (i) => columns.map((_, c) => resolveCellDisplayValue(rows, columns, buffer, i, c))` and `columnNames = columns.map(c => c.name)`. Remove the `window.addEventListener("copy", …)` effect.
- [x] 1.3 MySQL `DataGrid.tsx`: same call, `resolveRow = (i) => columns.map(col => buffer.getDisplayValue(rows[i].rowKey, rows[i].cells, columnNames, col.name))`. Remove the `window` `copy` effect.
- [x] 1.4 MSSQL `DataGrid.tsx`: same call and resolver as MySQL. Remove the `window` `copy` effect.
- [x] 1.5 Confirm single-cell copy precedence, `Cmd+A` select-all, and the edit-mode guard (`if (editing) return`) still behave unchanged after the refactor.

## 2. Commit 1 — tests + verification gate

- [x] 2.1 Unit-test `copyRowRangeFromKeydown` for all 6 branches with a fake `resolveRow` + fake `write` (no DOM): (a) row-range + no active cell → `write` called with expected TSV + `preventDefault`; (b) `activeCell` set → returns false, `write` not called; (c) native-editable target → returns false; (d) null selection → returns false, no `onError`; (e) pending in-buffer edit → resolver value flows into TSV; (f) write rejects → `onError` called once.
- [x] 2.2 Grid-level Postgres integration test (extend the existing `DataGrid.contextMenu.test.tsx` harness or a new `DataGrid.copy.test.tsx`): mount the grid, establish a multi-row selection, dispatch a real `keydown` `Meta+C` (use `fireEvent`/`act` across ticks, not back-to-back helper calls with assumed state), assert the mocked clipboard received the expected TSV.
- [x] 2.3 **Verification gate (manual, blocking Commit 2):** build/run the packaged macOS app. Select multiple rows in a Postgres table, press ⌘C, paste into a spreadsheet — confirm one TSV line per row, tab-separated. Repeat single-row and `Cmd+A`→⌘C. If this fails, STOP and escalate to the Tauri clipboard plugin fallback before proceeding.

## 3. Commit 2 — row-number gutter (single-row selection)

- [x] 3.1 Postgres `DataGrid.tsx` + `DataGrid.module.css`: add a 32px row-number gutter. Header corner cell (empty) as the first child of `.headerRow`; a per-row gutter cell as the first child of `.row` showing `isInsert ? "+" : isDeleted ? "−" : vi.index + 1` (right-aligned, `--text-subtle`, tabular-nums, `cursor:pointer`, hover). Widen `thead`/`.body`/status-row width from `totalWidth` to `totalWidth + 32`.
- [x] 3.2 Postgres gutter `onMouseDown` (primary button): `e.preventDefault(); e.stopPropagation()`; if `shiftKey && selection.anchor !== null` → extend (`onSelectionChange({anchor: selection.anchor, active: vi.index})` + `onActiveCellChange(null)`); else `onActiveCellChange(null)` + `onSelectionChange({anchor: vi.index, active: vi.index})` and start the drag in `status:"active"` (anchorColIndex 0) via `dragRef`/`setDragActive(true)` so drag extends and `handleMouseUp` finalizes (never the click→cell branch).
- [x] 3.3 MySQL `DataGrid.tsx`: wire the existing 32px gutter cell (`:478`) — add `onClick`: shift+anchor → extend; else `setActiveCell(null)` + `onSelectionChange({anchor: rowIdx, active: rowIdx})`; add `cursor:pointer` + hover; focus the grid root (`(e.currentTarget.closest('[tabindex]') as HTMLElement)?.focus()`) so ⌘C works.
- [x] 3.4 MSSQL `DataGrid.tsx`: identical to MySQL (mirrors its structure).
- [x] 3.5 Tests: extend `DataGrid.copy.test.tsx` (Postgres) — click a gutter cell selects the row (`onSelectionChange` with `{anchor:i,active:i}` + `onActiveCellChange(null)`), then ⌘C copies that row's TSV; shift-click extends. Add a MySQL (and/or MSSQL) grid test that clicking the gutter selects the row.
- [x] 3.6 **Verification gate (manual):** in the packaged app, single-click a row's gutter number in Postgres → whole row highlights → ⌘C → one TSV line. Shift-click to extend. Repeat in MySQL/MSSQL.

## 4. Commit 3 — consolidation + failure feedback

- [x] 4.1 In the grid-clipboard module, add consolidated entry points for single-cell copy and context-menu row copy alongside `copyRowRangeFromKeydown`, so all three copy behaviors live in one module. Each grid keeps only its engine-specific `resolveRow`/`columnNames` wiring.
- [x] 4.2 Change the write helpers (`copyRowsTsv`/`copyCellValue`) to report failure to the caller (return `boolean` or throw) instead of only `console.warn`.
- [x] 4.3 Wire grid copy failures to the toast: grid components pass `onError = (msg) => useToast().show(msg, "error")`. Failure-only, non-blocking, never on success, never on empty-selection no-op.
- [x] 4.4 Repoint Postgres, MySQL, and MSSQL single-cell copy and context-menu copy through the consolidated module; delete the now-duplicated per-grid copy code.

## 5. Commit 3 — tests

- [x] 5.1 Unit-test that a failing `write` triggers `onError` for both single-cell and row-range paths, and that a successful copy triggers no `onError`.
- [x] 5.2 Grid-level test that a copy failure surfaces an error toast (mock `useToast`) and a successful copy shows none.
- [x] 5.3 Run the full clipboard suite (`packages/app/src/platform/grid/cellClipboard.test.ts` + new tests) and the grid test suites for all three engines; run typecheck/lint.

## 6. Follow-up (out of scope — tracked in GitHub issue #214)

- [ ] 6.1 Extend copy-failure feedback to the ~10 non-grid copy sites (DDL, ARN, SQL history, chat code, updater logs) for app-wide consistency. Documented in the follow-up issue, not built here.
