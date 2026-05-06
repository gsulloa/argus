## Why

The Postgres SQL editor today is functional but feels bare next to the rest of the app: there is no way to format SQL, the running indicator is a static "Running…" string with no sense of how long the query has been in flight, and once a result lands there is no path to get it out of the app. Three small additions close those gaps without expanding the editor's surface area.

## What Changes

- **Format SQL button** in a new editor toolbar (top of the editor area). Clicking it — or pressing `Mod-Shift-F` — runs the entire buffer through `sql-formatter` with the `postgresql` dialect and replaces the document. Cursor lands at offset 0 after format.
- **Live elapsed-time indicator** while a query is running. The summary slot in the result header ticks at 100ms and reads `Running…` for the first second, `Running… 1.2s` from 1s onward, and `Running… 1:23` past 60s. After the run completes, the existing `<rows> · <ms> ms` summary takes over — server-side `query_ms` wins over client-side timing.
- **Export results** dropdown in the result header (next to the summary). Three formats: CSV (UTF-8 + BOM), Excel `.xlsx` (real cell types), JSONL (one row per line). Only enabled for single-statement, `kind: "rows"` results. Truncated results export only the rows in memory with a warning surfaced in the save dialog's default filename (`*_truncated.csv`). Multi-statement runs and `kind: "affected"` results do not get an export action in V1.
- **Fix global shortcuts swallowed by the SQL editor.** Today `useShortcuts` skips when the focused element is `contentEditable`, and CodeMirror's `.cm-content` is contentEditable — so `⌘K` (command palette), `⌘P` (table quick-switcher), `⌘⇧P`, `⌘W`, `⌘\`, and `⌘,` silently no-op while the user is typing in any SQL editor. All base shortcuts registered in `App.tsx` MUST fire regardless of the focus context.
- New runtime dependencies: `sql-formatter`, `exceljs`, `@tauri-apps/plugin-fs`.

No breaking changes. No backend changes (all three features live entirely in the frontend; file writes go through `plugin-fs`).

## Capabilities

### New Capabilities
_None._

### Modified Capabilities
- `postgres-sql-editor`: adds three new requirements (Format SQL action, Live elapsed-time indicator while running, Export results to CSV/Excel/JSONL) and modifies the existing "Bottom status indicator" requirement to include the running-timer behavior.
- `app-shell`: modifies the existing "Base keyboard shortcuts" requirement so the registered base shortcuts (⌘K, ⌘⇧P, ⌘P, ⌘W, ⌘\, ⌘,) fire regardless of the focused element — including when focus is inside a CodeMirror SQL editor (or any other contenteditable surface).

## Impact

- **Frontend code**:
  - `src/modules/postgres/sql/QueryTab.tsx` — adds a toolbar above the editor (format button) and an export dropdown in the result header.
  - `src/modules/postgres/sql/QueryEditor.tsx` — exposes a format method via the imperative handle and a `Mod-Shift-F` keybinding.
  - `src/modules/postgres/sql/useQueryRun.ts` — tracks `runStartedAt` and exposes `elapsedMs` so the header can render a live timer without re-rendering the editor on every tick.
  - New: `src/modules/postgres/sql/format.ts` (`sql-formatter` wrapper with the project's preset).
  - New: `src/modules/postgres/sql/export/` (`toCsv.ts`, `toJsonl.ts`, `toXlsx.ts`, `saveExport.ts` for the dialog + write flow, `ExportMenu.tsx` for the dropdown).
  - `src/app/App.tsx` — base shortcut bindings get `whenInInput: true` so they fire from contenteditable surfaces.
- **Dependencies**: `sql-formatter`, `exceljs`, `@tauri-apps/plugin-fs` added to `package.json`. Bundle impact ~600kb gzipped (mostly `exceljs`); acceptable for a desktop app and lazy-loadable on first export click if it shows up as a perf issue.
- **Tauri**: `@tauri-apps/plugin-fs` capability needs to be allowed in `src-tauri/capabilities/` for `fs:write-binary-file`. No new Rust commands.
- **Specs**: `openspec/specs/postgres-sql-editor/spec.md` gets the deltas.
- **Out of scope**: query cancellation (separate concern surfaced by the live timer but not included here), exporting truncated results by re-running without a cap, exporting multi-statement runs, format-on-save.
