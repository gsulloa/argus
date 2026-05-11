## Context

The Postgres SQL editor (`src/modules/postgres/sql/`) is built on CodeMirror 6 with a small per-tab state hook (`useQueryRun`) and a result panel that renders either an `AdhocResultGrid`, an affected-rows summary, or an error block. There is no editor toolbar, no client-side timer for in-flight queries (the `summary` getter just returns the literal `"Running…"` while running), and no path to extract result rows out of the app. Results live in memory in `RunSqlResult` shape (`{ kind: "rows", columns: DataColumn[], rows: Value[][], truncated, query_ms }`) — already structured enough to format directly.

This change is a frontend-only addition. The backend `postgres_run_sql` / `postgres_run_sql_many` contracts and the row cap are unchanged.

## Goals / Non-Goals

**Goals:**
- A format button + `Mod-Shift-F` shortcut that produces consistent, predictable Postgres-flavored SQL.
- A live timer next to `Running…` that gives the user a felt sense of how long the query has been in flight.
- A one-click path to get the current result out as CSV, Excel, or JSONL, preserving null/number/date semantics where the format allows.
- Zero changes to backend contracts; zero new Tauri commands.

**Non-Goals:**
- Query cancellation. The live timer makes long queries visible but does not give the user a way to abort them. That is a separate change.
- Re-running the query without the 10k cap to export the full result set. We export only what is in memory.
- Format-on-save, format-on-paste, or format-the-statement-under-cursor. V1 is whole-buffer only.
- Exporting multi-statement runs (would require deciding between per-tab files, a zip, or Excel sheets — not worth the complexity for V1).
- Exporting `kind: "affected"` results.
- Streaming export for very large result sets. The 10k cap means worst case is 10k rows × N columns, which `exceljs` handles fine in memory.

## Decisions

### D1. SQL formatter library: `sql-formatter`

`sql-formatter` is the de-facto standard, ~120kb gzipped, supports a `postgresql` dialect natively, and is configurable. Alternatives considered:

- `prettier-plugin-sql`: pulls in prettier as runtime, awkward and bigger; uses `sql-formatter` under the hood anyway.
- `pg-formatter` (pgFormatter port): higher quality output but a much heavier wasm port.

Configuration:

```ts
{
  language: "postgresql",
  keywordCase: "upper",        // SELECT, FROM, WHERE — industry convention
  identifierCase: "preserve",  // do not mangle quoted identifiers
  dataTypeCase: "upper",       // INTEGER, TEXT
  functionCase: "lower",       // now(), coalesce()
  indentStyle: "standard",
  tabWidth: 2,
  expressionWidth: 80,
  linesBetweenQueries: 1,
}
```

Cursor handling: after format, set the editor's selection to `{anchor: 0, head: 0}` and scroll to top. Preserving cursor through a full reformat is complex and not worth it for V1; users formatting a buffer expect the whole thing to be touched.

### D2. Format scope: whole buffer

Always format the entire document. Selection-only and statement-under-cursor formatting were considered (would mirror the run-SQL precedence model), but the precedence model exists because run-SQL is destructive (it actually executes); format is local and reversible (Mod-Z), and the simpler "format everything" is the least surprising default. If the user explicitly selects text and we do nothing, that feels broken; if we format only the selection silently, the rest of the buffer is left in inconsistent style.

If the document is empty or whitespace-only, the format command is a no-op (no error, no edit).

### D3. Live timer: tick in the result header, not in `useQueryRun`

`useQueryRun` exposes `runStartedAt: number | null` (set when status transitions to `running`, cleared when it transitions to `done`/`idle`). The result-header component owns the `setInterval(100)` and reads `runStartedAt` to compute elapsed. This isolates the re-render to the small piece of UI that needs it, avoiding re-renders of the editor or grid every 100ms.

Format rules (`formatElapsed(ms)`):
- `ms < 1000` → `Running…` (no number; avoids parpadeo on cheap queries).
- `1000 ≤ ms < 60_000` → `Running… ${(ms/1000).toFixed(1)}s` (e.g. `Running… 1.2s`).
- `ms ≥ 60_000` → `Running… ${m}:${ss.padStart(2, "0")}` (e.g. `Running… 1:23`).

After completion, the existing `summarize()` output takes over verbatim — server-reported `query_ms` is the source of truth for the final number. The interval is cleared in the `useEffect` cleanup so an unmounting tab does not leak a tick.

### D4. Export menu: dropdown in result header, single-statement rows-only

A small "Export ▾" trigger sits in `.resultHeader` to the right of `runSummary`. The dropdown uses Radix (already a dep) and lists `Export as CSV`, `Export as Excel (.xlsx)`, `Export as JSONL`.

The trigger is rendered (and enabled) only when:
- `runner.state.status === "done"` AND
- `runner.state.mode === "single"` AND
- `runner.state.result?.kind === "rows"` AND
- `runner.state.result.rows.length > 0`.

Multi-statement runs and `affected` results show no export button. This is the V1 cut described in the proposal; it can be widened later.

### D5. Format-specific decisions

**CSV** (hand-rolled, no lib):
- UTF-8 with leading BOM (`﻿`) so Excel opens it correctly with non-ASCII characters.
- RFC 4180 quoting: a field is quoted if it contains `"`, `,`, `\n`, or `\r`; embedded `"` is escaped as `""`.
- `null` cells → empty string (matches Postgres `COPY ... FORMAT csv` default).
- Numbers → `String(n)`. Booleans → `"true"`/`"false"`. Dates and other complex types come through `Value` as strings already (the backend serializes them); we pass them through as-is.
- Header row uses column `name`.
- Line ending `\r\n`.

**JSONL** (hand-rolled):
- One JSON object per line, keys are column `name`, values are the `Value` cells. `null` → `null`. Numbers stay numeric. The `Value` envelope already handles binary/truncated cells; we serialize whatever is there.
- No trailing newline.

**Excel `.xlsx`** (`exceljs`):
- One sheet named `Result`.
- Header row in row 1, frozen.
- Cell typing driven by `DataColumn.data_type`:
  - `int*`, `numeric`, `float*`, `double precision`, `real` → `Number(value)` if finite, else string.
  - `bool`, `boolean` → `Boolean(value)`.
  - `timestamp*`, `date` → parsed via `new Date(value)`; if `NaN`, fall back to string.
  - `json`, `jsonb` → `JSON.stringify(value)` to keep it readable as a single cell.
  - Anything else → `String(value)` (or empty for null).
- Null cells written as empty (not the literal string `null`).
- Sheet width per column derived from the longest cell up to a cap of 60 chars.

### D6. Saving the file: `@tauri-apps/plugin-fs` + `plugin-dialog`

Already have `plugin-dialog`. Add `@tauri-apps/plugin-fs` for `writeFile` (binary: `Uint8Array` for `.xlsx`) and `writeTextFile` (CSV/JSONL). Permissions added in `src-tauri/capabilities/`:

- `fs:default` is too broad. Restrict to `fs:allow-write-file` scoped to `$DOWNLOAD/*` and `$DOCUMENT/*` (Tauri scope syntax). Users picking a path elsewhere will see Tauri's standard scope-prompt; that is acceptable.

Default save filename: `${connectionName}_query_${YYYYMMDD_HHmmss}.${ext}`, with `_truncated` appended before the extension when `result.truncated === true`. The save dialog's filter matches the chosen format.

If the user cancels the save dialog (returns `null`), the export silently no-ops. On write error, surface a toast (existing toast system; verify in `src/platform/`) — no destructive consequences if it fails.

### D7. Lazy-load `exceljs`

`exceljs` is the heaviest of the three deps. Wrap it behind a dynamic `import()` so it only loads when the user clicks `Export as Excel`. Keeps the cold-start bundle smaller and removes `exceljs` from the editor's critical path.

### D8. Toolbar layout: thin strip above the editor

A new `editorToolbar` row at the top of `QueryTab.tsx`'s `editorArea`. Single button for V1 (`Format`), left-aligned, with a small kbd hint (`⌘⇧F`). Uses existing button styles from the design system — no decorative chrome, low contrast, matches the calm aesthetic in `DESIGN.md`.

This deliberately does not become a "command bar" — Argus uses the command palette and keymaps as the primary surface. The toolbar exists because format is non-obvious without a button; once someone learns the shortcut they will not look at the toolbar again.

### D9. Base shortcuts must escape the contenteditable trap

`useShortcuts` (`src/platform/shell/useShortcuts.ts:30-36`) skips its handler when `event.target.isContentEditable` is true. CodeMirror 6 mounts a `.cm-content` element with `contenteditable="true"`, so any time a SQL editor has focus the global shortcut handler is short-circuited and the keystroke falls through to CodeMirror — which has no binding for `⌘K`, `⌘P`, etc. — and effectively dies.

The fix: every base shortcut registered in `App.tsx:101-117` (k, shift+p, p, w, `\`, `,`) MUST set `whenInInput: true`. These are all `mod: true` (Cmd/Ctrl held) navigation commands, so they cannot collide with text input — and `useShortcuts` already calls `e.preventDefault()` on match, so CodeMirror will not also receive the keystroke as an editing command.

Alternative considered: change the `useShortcuts` default so any `mod: true` binding fires regardless of focus. Rejected — it changes the behavior of every existing call site implicitly. Per-binding `whenInInput: true` is explicit and reviewable.

Out of scope: scoped shortcuts (e.g. `Mod-K` inside a search input that should mean "clear" rather than "open palette"). Argus has no such bindings today; if one is added later, the `whenInInput` flag remains a per-binding decision.

## Risks / Trade-offs

- **Bundle size grows ~600kb.** → Lazy-load `exceljs` (D7); accept `sql-formatter` cost since format is on the hot path.
- **`exceljs` typing for `jsonb` is lossy.** → Stringify to JSON in the cell (D5). Users who want structural fidelity export JSONL.
- **Format with cursor at offset 0 surprises users mid-edit.** → Document the choice in design.md and surface it as a tooltip on the button ("formats the whole buffer"). Alternative is preserving cursor via offset mapping; non-trivial and out of scope.
- **Live timer at 100ms could feel jittery on a slow machine.** → 100ms is well above any realistic React re-render cost for a 30-character string; the interval lives only on the header, so no big subtrees re-render. If real-world testing shows jitter, drop to 200ms.
- **Tauri scope prompt may interrupt the export flow.** → The default scope (`$DOWNLOAD`, `$DOCUMENT`) covers >95% of cases. Outside those, the prompt is a one-time approval per path.
- **Truncation marker in filename is easy to miss.** → Acceptable; the truncation banner already shows above the grid. The filename suffix is a belt-and-suspenders cue, not the primary signal.

## Migration Plan

No data migration. Deploy is additive. Rollback: revert the change; no persisted state changes (the `pgQueryResultHeight` setting is unchanged, no new settings keys).

## Open Questions

- Should the Format button live above the editor (D8) or in the result header next to Export? Above the editor is more discoverable for an editor action; result header is more compact. Going with above-the-editor unless this feels off in practice.
- `sql-formatter` keyword case default of `upper` vs the design system's "calm" ethos. Going with `upper` because it is the SQL convention and what the dialect highlighter already emphasizes; revisit if user feedback says otherwise.
