## 1. Shared clipboard read helper

- [x] 1.1 In `packages/app/src/platform/clipboard/index.ts`, add `readClipboardText(): Promise<string | null>` wrapping `navigator.clipboard.readText()`, returning `null` on failure (log a `console.warn` like `writeClipboardText`).
- [x] 1.2 In the same file, add `export const PASTE_FAILED_MESSAGE = "Paste failed";` (and an empty-clipboard variant, e.g. `"Nothing to paste";`) for callers to surface via toast.

## 2. Shared paste helper + TSV parser

- [x] 2.1 Create `packages/app/src/platform/grid/gridPaste.ts`.
- [x] 2.2 Implement `parseTsvRows(text: string): string[][]` — split on `\n`, strip a trailing `\r` from each line, drop a single trailing empty line, split each line on `\t`. Pure, no DOM. This is the inverse of `formatRowsTSV`.
- [x] 2.3 Implement `pasteRowRangeFromKeydown(e, deps): Promise<boolean>` mirroring `copyRowRangeFromKeydown` in `gridCopy.ts`: use the same `CopyKeyEvent`-style structural event; decline (return `false`, no `preventDefault`) when `deps.editing`, the target is `INPUT`/`TEXTAREA`/`SELECT`/`contentEditable`, `deps.activeCell !== null`, or the selection anchor/active is `null`.
- [x] 2.4 On the accepted path: call `e.preventDefault()` synchronously, then `await deps.read()`; if the result is `null` call `deps.onError?.(PASTE_FAILED_MESSAGE)` and return `true`; if it parses to zero rows call `deps.onError?.` with the empty-clipboard message and return `true`.
- [x] 2.5 Map each parsed row positionally to `deps.columns[i].name`, **omitting** any column present in `deps.pkColumns`; map empty cells to `null`; ignore cells beyond the column count; leave missing trailing columns unset. Produce `Record<string, EditValue>[]` and pass it to `deps.onPasteRows(valuesList)`; return `true`.
- [x] 2.6 Define the `deps` interface (`editing`, `activeCell`, `selection`, `columns`, `pkColumns`, `read`, `onPasteRows`, `onError`) with the same structural, DOM-agnostic style as `CopyRowRangeDeps`.

## 3. Grid keydown wiring (all three engines)

- [x] 3.1 In `packages/app/src/modules/postgres/data/DataGrid.tsx` `onGridKeyDown`, add a ⌘V/Ctrl+V branch (`(e.metaKey || e.ctrlKey)` + `key === "v"`) that calls `pasteRowRangeFromKeydown(e, { editing, activeCell, selection, columns, pkColumns, read: readClipboardText, onPasteRows, onError: onPasteError })`, placed alongside the existing ⌘C branch.
- [x] 3.2 Add the `onPasteRows` and `pkColumns` props (and `onPasteError` or reuse the existing copy-error toast wiring) to the Postgres `DataGrid` props type.
- [x] 3.3 Repeat 3.1–3.2 for `packages/app/src/modules/mysql/data/DataGrid.tsx`.
- [x] 3.4 Repeat 3.1–3.2 for `packages/app/src/modules/mssql/data/DataGrid.tsx`.

## 4. Parent tab: insert + select pasted rows (all three engines)

- [x] 4.1 In `packages/app/src/modules/postgres/data/TableViewerTab.tsx`, implement `onPasteInsertRows(valuesList)`: guard `isReadOnly` and `relationKind !== "table"` (same as `onAddRow`), loop `buffer.addInsertRow(values)` per entry, then set `selection` to cover the pasted rows at the top, clear `activeCell`, and `gridRef.current?.scrollToTop()`.
- [x] 4.2 Pass `onPasteInsertRows` and `pkColumns` down to the Postgres `DataGrid`.
- [x] 4.3 Repeat 4.1–4.2 for `packages/app/src/modules/mysql/data/TableViewerTab.tsx`.
- [x] 4.4 Repeat 4.1–4.2 for `packages/app/src/modules/mssql/data/TableViewerTab.tsx`.

## 5. Tests

- [x] 5.1 Unit-test `parseTsvRows`: single line, multiple lines, trailing newline, `\r\n` line endings, empty cells, and empty input.
- [x] 5.2 Unit-test `pasteRowRangeFromKeydown` decline paths: edit mode, native-editable target, active cell present, empty selection (each returns `false`, no `preventDefault`, no `onPasteRows`).
- [x] 5.3 Unit-test `pasteRowRangeFromKeydown` accept paths: positional mapping, PK-column omission, empty-cell→null, short line leaves trailing columns unset, long line ignores extras, and `onPasteRows` receives the expected `Record<string, EditValue>[]`.
- [x] 5.4 Unit-test failure surfacing: `read()` returns `null` → `onError(PASTE_FAILED_MESSAGE)` and no rows; parsed-to-zero → empty-clipboard error; successful paste → no `onError`.
- [x] 5.5 Add/extend a round-trip test asserting `parseTsvRows(formatRowsTSV(rows))` reproduces the source cell strings.

## 6. Verification

- [ ] 6.1 Manually verify in the running app (Postgres): select a row via the gutter, ⌘C, ⌘V → a new pending insert row appears at top with the copied values and a fresh (unset) SERIAL PK; Save assigns a new id.
- [ ] 6.2 Verify multi-row paste, paste inside an open cell editor falls through to native paste, and ⌘V with a single active cell does nothing.
- [ ] 6.3 Verify parity across MySQL and MSSQL grids.
- [x] 6.4 Run the app lint/typecheck/test scripts and confirm they pass. (`tsc --noEmit` clean; eslint 0 errors — 4 pre-existing warnings unrelated to this change; 583 grid/clipboard/engine tests pass, full suite 1648/1651 with no failures.)
