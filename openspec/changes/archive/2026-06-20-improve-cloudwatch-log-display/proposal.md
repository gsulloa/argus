## Why

Two problems with the CloudWatch log-viewing experience:

1. **The query's `limit` is ignored.** A query like `fields @timestamp, @message | limit 100` returns **1000** rows. The backend always passes a default `limit` of 1000 to `StartQuery`, which overrides the `| limit` command in the query string. The user's explicit limit silently does nothing — wrong and confusing, and it scans/returns far more than asked.
2. **Logs render as a generic truncated grid.** Insights results and the raw event tail render every value as a single-line, ellipsis-clipped monospace cell capped at 320px. Logs are the opposite of tabular data: `@message` is usually long text or JSON, `@timestamp` arrives as a raw value, and there is no way to read a full message or pretty-print JSON. It reads like a spreadsheet, not a log viewer, and ignores the readability the `/frontend-design` pass calls for.

## What Changes

- **Honor the query's `limit`**: stop forcing a default `StartQuery` limit. When the query string already contains a `limit` command, send no `limit` param so the query governs. When it doesn't, fall back to a sane default capped by the client row cap. Result: `| limit 100` returns 100.
- **Log-readable result rendering** (Insights `ResultPanel`), grounded in `DESIGN.md`:
  - **Timestamp column**: render `@timestamp` (and event `ts`) as a fixed-width, human-readable local datetime with milliseconds, in `--font-mono`, subtle color — not a raw clipped string.
  - **Expandable message / detail row**: clicking a row expands an inline detail panel showing the full `@message` (wrapped, selectable); when the value is JSON, pretty-print it. No more unreadable 320px-clipped cells for the message field.
  - **Density & polish per DESIGN.md**: compact rows, hairline borders, zebra/hover affordance, sticky header, `--font-mono` values, proper running (subtle Scan-consistent) and empty states. No decorative gradients, no thick borders, single accent.
- **Same treatment for the raw event tail** (`EventsTab`): readable timestamp column + expandable/wrapping message with JSON pretty-print, consistent with the Insights panel.

## Capabilities

### Modified Capabilities
- `cloudwatch-insights-editor`: the run-lifecycle requirement is refined so the query's own `limit` command is honored (no forced override), and the result-rendering requirement is extended for log-readable display (timestamp formatting, expandable full-message/JSON view).
- `cloudwatch-logs-browser`: the raw event tail requirement is extended for log-readable rendering (timestamp formatting, expandable/wrapping message with JSON pretty-print).

## Impact

- **Backend (`src-tauri/src/modules/cloudwatch/insights.rs`)**: `cloudwatch_run_insights` only sets `StartQuery.limit` when the query string has no `limit` command; the `RESULT_ROW_CAP` stays as the hard safety cap. Add a unit test for the "query has limit → no param" branch.
- **Frontend (`src/modules/cloudwatch/insights/ResultPanel.tsx`, `events/EventsTab.tsx`)**: timestamp formatting helper, expandable row / detail view with JSON detection + pretty-print, and a styling pass to `DESIGN.md` tokens. `useQueryRun`/`api` may stop sending a default limit. No new backend command.
- **No change** to connection lifecycle, the query language, persistence, or events.

## Non-goals

- A general virtualized/windowed grid rewrite — current row counts (≤ cap) render fine; this is a readability pass, not a perf rewrite.
- Server-side `limit` UI control — out of scope; the query's `| limit` is the lever.
- Severity/level parsing and coloring beyond what falls out naturally — can be a follow-up.
- Live Tail streaming (already a separate non-goal).
