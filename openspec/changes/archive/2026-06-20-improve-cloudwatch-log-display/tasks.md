## 1. Backend — honor the query's limit

- [x] 1.1 `cloudwatch/insights.rs`: add `has_limit_command(query: &str) -> bool` (case-insensitive regex `(^|\|)\s*limit\s+\d+`); in `cloudwatch_run_insights`, only set `StartQuery.limit` when the query has no limit command. Keep `RESULT_ROW_CAP` as the hard client cap + `truncated`
- [x] 1.2 Backend unit test: `has_limit_command` true/false cases (`"… | limit 100"`, `"limit 5"`, `"fields @x"`, embedded-in-word negatives) and that a default is used only when absent

## 2. Frontend — shared log-render helpers

- [x] 2.1 Add a `formatLogTs(value: string | number)` helper (e.g. in `src/modules/cloudwatch/insights/` or a `shared` spot reused by both panels): parse epoch-ms or Insights timestamp string → `YYYY-MM-DD HH:mm:ss.SSS` local
- [x] 2.2 Add a small `prettyMaybeJson(text: string): { isJson: boolean; text: string }` helper that tries `JSON.parse` and returns 2-space pretty-printed text when valid, else the original

## 3. Frontend — Insights result panel (cloudwatch-insights-editor)

- [x] 3.1 `insights/ResultPanel.tsx`: render the timestamp column via `formatLogTs`, fixed-width, `--font-mono`, `--text-muted`
- [x] 3.2 Make rows expandable: clicking a row toggles an inline detail row (spanning all columns) showing the full message wrapped + selectable; pretty-print JSON via `prettyMaybeJson` in a `<pre>` with `white-space: pre-wrap`. Single row expanded at a time
- [x] 3.3 Styling pass to DESIGN.md: compact `5px 12px` cells, hairline `--border`, sticky header, hover highlight at `--duration-instant`, `--radius-md`, single `--accent`; keep existing sort, cell-copy, and `ExportMenu` working
- [x] 3.4 Quiet running/empty/error states consistent with the app (no spinner zoo; existing alert style for errors)

## 4. Frontend — raw event tail (cloudwatch-logs-browser)

- [x] 4.1 `events/EventsTab.tsx`: render the event timestamp via `formatLogTs` (fixed-width mono column)
- [x] 4.2 Make the message readable in full — wrapped + selectable, JSON pretty-printed via `prettyMaybeJson` (expandable row or always-wrapped, implementer's call); keep read-only + older/newer paging
- [x] 4.3 Styling pass to DESIGN.md, consistent with the Insights panel

## 5. Verification

- [x] 5.1 `cargo test cloudwatch` and `pnpm typecheck` + lint pass; apply the `/frontend-design` lens (no gradients/thick borders/bubbly radii/multiple accents)
- [x] 5.2 Manual smoke: run `… | limit 100` and confirm exactly ≤ 100 rows; run a query whose `@message` is long JSON and confirm the row expands to a pretty-printed, readable message; open the raw event tail and confirm timestamps + messages read well; sort and export still work
