## Why

Opening a log group's stream shows the raw event tail (`EventsTab`) — often hundreds of lines per page. There is no way to narrow them: to find the line you care about you scan visually or rely on the browser's native find (which only matches what's painted and fights the app's own shortcuts). Every other data surface in Argus (Postgres `TableViewerTab`, Dynamo `DataViewTab`) already answers ⌘F with an in-app filter; the log viewer should too. Server-side group search already shipped; this is the complementary **local** filter over the events you're already looking at.

## What Changes

- **⌘F opens a local filter bar in the event tail viewer.** Pressing ⌘F (⌃F on non-mac) while the events tab is focused opens a small inline filter input at the top of the events list (intercepting the browser's native find), autofocused. `Esc` closes and clears it.
- **Text-only, case-insensitive, fuzzy.** The input accepts plain text only (no operators/regex). Matching is **case-insensitive** and **fuzzy**: a case-insensitive substring match, with a fuzzy subsequence match as a fallback so scattered characters still hit. The query filters the **already-loaded** events client-side — no refetch.
- **Filter feedback**: the bar shows "N of M" (matched / loaded). The filter applies to the full loaded set, so "load older / newer" pages keep filtering as they arrive. Clearing or closing restores all loaded events.

## Capabilities

### Modified Capabilities
- `cloudwatch-logs-browser`: the raw event tail requirement is extended with an in-viewer, ⌘F-triggered **local** text filter over the loaded events — case-insensitive, fuzzy, no refetch — distinct from the server-side log-group search.

## Impact

- **Frontend only** (`src/modules/cloudwatch/events/EventsTab.tsx`): add a ⌘F keydown listener gated on the tab being `active` (mirrors `DataViewTab`/`TableViewerTab`), an inline filter bar, filter state, and client-side filtering of the loaded `events` array. Add a small case-insensitive fuzzy matcher (subsequence) — prior art: `platform/command-palette/scoreTableEntry.ts`’s `fuzzySubsequenceScore`.
- **No backend change**, no new command, no refetch — purely local over loaded data.
- **No change** to streams, Insights, persistence, events, or the read-only nature of the viewer.

## Non-goals

- Server-side filtering or refetching by the query (the existing server-side group search and Insights cover account-wide search).
- Regex / boolean operators in the filter input — plain text only by request.
- A ⌘F filter in the Insights result panel — possible follow-up; this change targets the log-group event viewer specifically.
- Match highlighting within lines — optional polish, not required.
