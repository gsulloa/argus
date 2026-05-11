## 1. Dependencies & Tauri config

- [x] 1.1 Add `sql-formatter`, `exceljs`, and `@tauri-apps/plugin-fs` to `package.json` (use the latest versions compatible with Tauri 2 / React 18) and run `pnpm install`.
- [x] 1.2 Register the `tauri-plugin-fs` plugin in `src-tauri/src/lib.rs` (`.plugin(tauri_plugin_fs::init())`).
- [x] 1.3 Add `fs:allow-write-file` and `fs:allow-write-text-file` permissions to the relevant capability JSON in `src-tauri/capabilities/`, scoped to `$DOWNLOAD/*` and `$DOCUMENT/*`.
- [x] 1.4 Verify the existing `dialog:allow-save` permission is granted (it already should be).

## 2. SQL formatter helper

- [x] 2.1 Create `src/modules/postgres/sql/format.ts` exporting `formatSql(input: string): string` that wraps `sql-formatter` with the preset from `design.md` D1 (`{ language: "postgresql", keywordCase: "upper", identifierCase: "preserve", dataTypeCase: "upper", functionCase: "lower", indentStyle: "standard", tabWidth: 2, expressionWidth: 80, linesBetweenQueries: 1 }`).
- [x] 2.2 Make `formatSql` return the input unchanged when the input is empty/whitespace.
- [x] 2.3 Make `formatSql` re-throw errors from `sql-formatter` so the caller can show a toast (do not swallow).
- [x] 2.4 Add unit tests for the trivial cases (empty input, lowercased keywords get uppercased, identifiers preserved).

## 3. Editor toolbar + format wiring

- [x] 3.1 In `QueryEditor.tsx`, extend `QueryEditorHandle` with `formatBuffer(): void` (imperative method).
- [x] 3.2 Implement `formatBuffer` to call `formatSql(view.state.doc.toString())`, dispatch one transaction replacing the document, set the selection to `{anchor: 0, head: 0}`, and scroll to top. On `formatSql` throw, show toast `Could not format SQL` (via the existing toast util — locate in `src/platform/`) and leave the buffer untouched.
- [x] 3.3 Add a CodeMirror keymap binding for `Mod-Shift-F` at `Prec.highest` that calls `formatBuffer`.
- [x] 3.4 Add a thin `editorToolbar` row at the top of `QueryTab.tsx`'s `editorArea`, containing a single `Format` button with the kbd hint `⌘⇧F` (or `Ctrl+Shift+F` on non-Mac — reuse any existing platform helper).
- [x] 3.5 Wire the button's `onClick` to `editorRef.current?.formatBuffer()`.
- [x] 3.6 Add styles for `.editorToolbar` in `QueryTab.module.css` matching the calm aesthetic in `DESIGN.md` (low contrast, no decorative chrome, height ≤ 32px).

## 4. Live elapsed-time indicator

- [x] 4.1 In `useQueryRun.ts`, add `runStartedAt: number | null` to the returned object. Set it via `Date.now()` when transitioning to `running`; clear it on transition to `done` or `idle`.
- [x] 4.2 In `QueryTab.tsx`'s result-header subtree (extract a small `RunSummary` component if it makes the JSX cleaner), use `useEffect` to start a `setInterval(tick, 100)` while `runStartedAt !== null && state.status === "running"`. Clear on cleanup. The interval body just calls a `setNow(Date.now())` to force a header re-render.
- [x] 4.3 Implement `formatElapsed(ms): string` per design D3: `<1000` → `Running…`; `<60000` → `Running… ${(ms/1000).toFixed(1)}s`; `>=60000` → `Running… ${m}:${ss.padStart(2,"0")}`.
- [x] 4.4 In the header, when `state.status === "running"`, render `formatElapsed(now - runStartedAt)` instead of the static string from `summarize()`. After completion, `summarize()` continues to drive the text.
- [x] 4.5 Verify by inspection (React DevTools) that the editor and grid components do not re-render on the 100ms tick — only the header re-renders. (Tick lives inside the isolated `RunSummary` component; only that subtree re-renders.)

## 5. Export: serializers

- [x] 5.1 Create `src/modules/postgres/sql/export/toCsv.ts` with `toCsv(columns: DataColumn[], rows: Value[][]): string`. Implement RFC 4180 quoting per design D5 (CSV bullet) and prepend a UTF-8 BOM (`﻿`). Use `\r\n` line endings. Null cells → empty.
- [x] 5.2 Create `src/modules/postgres/sql/export/toJsonl.ts` with `toJsonl(columns, rows): string` that builds one `JSON.stringify({col: value, …})` per row, joined by `\n` with no trailing newline.
- [x] 5.3 Create `src/modules/postgres/sql/export/toXlsx.ts` with `async toXlsx(columns, rows): Promise<Uint8Array>` that lazy-imports `exceljs`, builds a workbook with one sheet `Result`, header at row 1 (frozen), per-cell typing per design D5 (XLSX bullet) driven by `DataColumn.data_type`, and column widths derived from longest cell capped at 60 chars. Return the workbook serialized via `workbook.xlsx.writeBuffer()` as `Uint8Array`.
- [x] 5.4 Add unit tests covering CSV quoting (commas, quotes, newlines), CSV null handling, JSONL JSON-native types, JSONL null handling, and XLSX cell typing for at least int, bool, timestamp, and jsonb columns.

## 6. Export: save dialog & file write

- [x] 6.1 Create `src/modules/postgres/sql/export/saveExport.ts` with `async saveExport({format, connectionName, truncated, contents})` that opens the Tauri save dialog (`@tauri-apps/plugin-dialog`) with the right extension filter and a default filename `${connectionName}_query_${YYYYMMDD_HHmmss}${truncated ? "_truncated" : ""}.${ext}`.
- [x] 6.2 If the user cancels (path is `null`), return without writing and without toast.
- [x] 6.3 If the user confirms, call `writeTextFile(path, contents)` for CSV/JSONL or `writeFile(path, contents)` for XLSX from `@tauri-apps/plugin-fs`.
- [x] 6.4 On success, surface toast `Exported ${rowCount.toLocaleString()} rows`.
- [x] 6.5 On write error, surface toast `Export failed: ${err.message}` and log the error.

## 7. Export: dropdown UI

- [x] 7.1 Create `src/modules/postgres/sql/export/ExportMenu.tsx` using Radix DropdownMenu (already a dep). Trigger label: `Export ▾`. Items: `Export as CSV`, `Export as Excel (.xlsx)`, `Export as JSONL`.
- [x] 7.2 The component takes props `{ connectionName: string, columns: DataColumn[], rows: Value[][], truncated: boolean }` and dispatches the right serializer + `saveExport` on each item click.
- [x] 7.3 In `QueryTab.tsx`'s result header, render `<ExportMenu />` to the right of `runSummary` only when `runner.state.status === "done" && runner.state.mode === "single" && runner.state.result?.kind === "rows" && runner.state.result.rows.length > 0`.
- [x] 7.4 Style the dropdown trigger to match other small actions (no decorative chrome, compact, fits inline with the summary text).

## 8. Fix global shortcuts swallowed by the SQL editor

- [x] 8.1 In `src/app/App.tsx` (the `useShortcuts([...])` call inside `ShortcutBindings`), add `whenInInput: true` to every base binding: `k`, `shift+p`, `p`, `w`, `\`, `,`. Do not change `useShortcuts.ts` itself — keep the default behavior unchanged for other call sites.
- [ ] 8.2 Verify in the dev build: focus the CodeMirror SQL editor, press `⌘K` → command palette opens; press `⌘P` → table quick-switcher opens; press `⌘W` → active tab closes; press `⌘\` → inspector toggles. Repeat from a focused `<input>` (e.g. the palette search input) — same behavior. _(Manual / out of agent scope.)_
- [x] 8.3 Verify CodeMirror does NOT also receive these keystrokes (no character inserted, no transaction dispatched) — `e.preventDefault()` in `useShortcuts.ts:44` already handles this; just confirm.

## 9. Verification

- [x] 9.1 Run `pnpm tsc --noEmit` and fix any type errors introduced.
- [x] 9.2 Run `pnpm test` (or whatever the project's test command is) and ensure new tests pass. _(`pnpm vitest run` → 109/109 pass.)_
- [ ] 9.3 Boot the app (`pnpm tauri dev`), open a Postgres connection, and manually verify: format button reformats; `Mod-Shift-F` works; long-running query (e.g. `SELECT pg_sleep(2.5)`) shows `Running… 1.2s`/`2.3s` ticking; export to CSV/XLSX/JSONL produce well-formed files; truncated query (force the cap) writes a `_truncated` filename; `⌘K` and `⌘P` open palette/quick-switcher with the SQL editor focused. _(Manual / out of agent scope — Tauri dev shell required.)_
- [x] 9.4 Sanity-check `DESIGN.md` compliance: toolbar uses Geist/Inter at the right weight, no bubbly radii, no AI-slop layouts, accent color used sparingly. _(Tokens come from existing `--font-mono`, `--border`, `--surface`; 3px radii, no gradients, accent only on hover/highlight.)_
- [x] 9.5 Run `openspec validate enhance-sql-editor --strict` and resolve any spec lint issues. _(Validates clean.)_
