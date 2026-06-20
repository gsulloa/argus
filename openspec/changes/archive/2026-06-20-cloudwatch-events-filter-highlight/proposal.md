## Why

The ⌘F local filter in the event tail viewer narrows the list, but the matched text isn't called out — the user still has to scan each surviving line to see *why* it matched. Highlighting the match (the same way the command palette highlights its matches, an explicitly accent-allowed use per `DESIGN.md`) makes the filter immediately legible: you see exactly which substring (or fuzzy characters) hit.

## What Changes

- **Highlight the matched text in filtered event messages.** While a filter query is active, each shown message renders with its matching portion marked in the brand accent. For the common **substring** filter, every case-insensitive occurrence of the query is highlighted. For the **fuzzy fallback** (when no substring matched), the matched characters are highlighted in order.
- **Subtle, on-brand styling**: highlight uses `--accent-soft` background / accent text per `DESIGN.md` (the token reserved for "palette match"), not a garish yellow. No highlight when the query is empty or the bar is closed.
- Highlighting operates on the **displayed** message text (including JSON pretty-printed messages), so what's marked is what's on screen.

## Capabilities

### Modified Capabilities
- `cloudwatch-logs-browser`: the in-viewer ⌘F local filter requirement is extended to highlight the matched text within each shown event message (all substring occurrences, or the fuzzy-matched characters when the fallback is used).

## Impact

- **Frontend only** (`src/modules/cloudwatch/events/EventsTab.tsx` + `logFormat.ts`): add a `highlightSegments(text, query)` helper that returns text/match segments (all case-insensitive substring occurrences; subsequence characters when no substring is present), and render the message cell as those segments with matched spans styled via accent tokens. Unit-test the segmenter.
- **No backend change**, no new command — purely presentational over the already-filtered list.
- **No change** to filtering behavior, streams, Insights, persistence, or events.

## Non-goals

- Highlighting in the Insights result panel — possible follow-up; this targets the event tail filter, consistent with where ⌘F lives.
- Match navigation (next/prev jump) — out of scope; this is visual highlighting only.
- Regex/operator highlighting — the filter is plain text.
