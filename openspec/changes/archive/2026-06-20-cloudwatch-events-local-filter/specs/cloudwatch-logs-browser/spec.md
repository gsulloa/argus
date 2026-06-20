## ADDED Requirements

### Requirement: In-viewer local event filter (⌘F)

The raw event tail viewer SHALL provide a local, in-app text filter opened with ⌘F (⌃F on non-mac) while the events tab is focused. Pressing the shortcut SHALL intercept the browser's native find, open a filter input at the top of the events list, and focus it; `Esc` SHALL close and clear it. The input accepts plain text only (no regex or operators). Matching SHALL be **case-insensitive** and **fuzzy** — a case-insensitive substring match, with an in-order subsequence match as a fallback. The filter applies **client-side to the already-loaded events only** (no refetch); it SHALL show a matched/loaded count and re-apply automatically as "load older / newer" brings in more events. The viewer remains read-only.

#### Scenario: ⌘F opens the local filter

- **WHEN** the events tab is focused and the user presses ⌘F
- **THEN** the browser's native find does not open, an in-app filter input appears at the top of the events list and is focused

#### Scenario: Case-insensitive fuzzy matching

- **WHEN** the user types a query into the filter
- **THEN** only loaded events whose message matches case-insensitively are shown — by substring, or by in-order subsequence as a fallback — and a "N of M" matched/loaded count is shown

#### Scenario: Filter is local and does not refetch

- **WHEN** a filter query is active
- **THEN** no new request is made; only the already-loaded events are filtered, and "load older / newer" remain available and feed the same filter

#### Scenario: Escape clears the filter

- **WHEN** the filter input is open and the user presses `Esc`
- **THEN** the filter bar closes, the query clears, and all loaded events are shown again

#### Scenario: No matches shows a quiet message

- **WHEN** a non-empty query matches none of the loaded events
- **THEN** the list shows a "no events match" message and keeps the "load older / newer" controls available
