## 1. Frontend — match segmenter

- [x] 1.1 Add `highlightSegments(text, query): Array<{ text: string; match: boolean }>` to `src/modules/cloudwatch/logFormat.ts`: empty query → single non-match segment; else find ALL non-overlapping case-insensitive substring occurrences and return alternating non-match/match segments; if there are no substring occurrences, fall back to marking the first in-order subsequence of the query's characters. Preserve original text/case
- [x] 1.2 Unit-test the segmenter: single occurrence, multiple occurrences, case-insensitivity, no-match→subsequence fallback, and empty query (whole string, unmarked)

## 2. Frontend — render highlights in EventsTab (cloudwatch-logs-browser)

- [x] 2.1 `events/EventsTab.tsx`: when `filterQuery.trim()` is non-empty, render the message cell as `highlightSegments(displayedText, filterQuery)` mapped to spans — matched segments wrapped in a highlight `<mark>`/span; otherwise render the plain string. Use the same displayed text (`prettyMaybeJson(...).text`) so highlights align
- [x] 2.2 Style the match span per DESIGN.md: `background: var(--accent-soft)`, accent/`--text` foreground, `--radius-sm`, inherit mono font; reset the browser's default `<mark>` yellow. No bold-everything

## 3. Verification

- [x] 3.1 `pnpm typecheck` + lint + the segmenter unit test pass; apply the `/frontend-design` lens (single accent, no yellow highlight, no thick borders)
- [x] 3.2 Manual smoke: ⌘F, type a substring present in several lines → all occurrences highlighted in accent; clear query → highlight gone; force a fuzzy-only query → matched characters highlighted; a JSON message highlights within the pretty-printed text
