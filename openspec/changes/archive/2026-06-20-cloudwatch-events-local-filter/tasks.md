## 1. Frontend — local fuzzy matcher

- [x] 1.1 Add a small case-insensitive matcher (e.g. `matchesLog(message, query): boolean` in `src/modules/cloudwatch/logFormat.ts`): empty query → true; otherwise lowercased substring match OR in-order subsequence fallback (modeled on `platform/command-palette/scoreTableEntry.ts`’s `fuzzySubsequenceScore`, returning a boolean). Unit-test substring, subsequence, case-insensitivity, and empty-query cases

## 2. Frontend — ⌘F filter bar in EventsTab (cloudwatch-logs-browser)

- [x] 2.1 `events/EventsTab.tsx`: thread `active` from `EventsTabRoot` into `EventsTabInner`; add `filterOpen` + `filterQuery` state
- [x] 2.2 Add a `window` keydown listener gated on `active`: on ⌘F/⌃F (no shift/alt) when focus isn't in an input/textarea/`.cm-editor`, `preventDefault()` and open+focus the filter input; on `Esc` (when open) close + clear. Mirror the `DataViewTab`/`TableViewerTab` pattern; clean up on unmount
- [x] 2.3 Render a compact filter bar at the top of the events list (DESIGN.md tokens: input `6px 10px`, hairline border, `--radius-md`) with the text input and an "N of M" matched/loaded count
- [x] 2.4 Filter the loaded `events` via a `useMemo` keyed on `(events, filterQuery)` using `matchesLog`; render the filtered list; keep "load older / newer" working and feeding the same filter
- [x] 2.5 Empty-result state: when a non-empty query matches no loaded events, show `No events match "<query>".` and keep the paging controls

## 3. Verification

- [x] 3.1 `pnpm typecheck` + lint pass; apply the `/frontend-design` lens (no gradients/thick borders/bubbly radii/multiple accents)
- [x] 3.2 Manual smoke: open a stream's events, press ⌘F (native find does not appear), type a lowercase substring of an upper-case message and confirm it matches; type scattered chars and confirm fuzzy match; `Esc` clears; "load older" pulls more and the filter still applies; a no-match query shows the quiet message
