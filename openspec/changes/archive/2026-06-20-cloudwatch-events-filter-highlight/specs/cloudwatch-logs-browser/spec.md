## ADDED Requirements

### Requirement: Highlight filter matches in event messages

While the in-viewer ⌘F filter has a non-empty query, each shown event message SHALL highlight the matched text using the brand accent (`--accent-soft` background per `DESIGN.md`). When the substring filter is active, every case-insensitive occurrence of the query within the message SHALL be highlighted. When the fuzzy fallback is in effect (no substring matched any line), the matched characters SHALL be highlighted in order. Highlighting applies to the displayed message text (including JSON pretty-printed messages) and is removed when the query is cleared or the filter bar is closed.

#### Scenario: Substring occurrences are highlighted

- **WHEN** a filter query is a case-insensitive substring of a shown message
- **THEN** every occurrence of the query within that message is visually highlighted in the accent style

#### Scenario: Fuzzy matches highlight the matched characters

- **WHEN** no message contains the query as a substring and the fuzzy fallback selects lines by subsequence
- **THEN** the in-order matched characters within each shown message are highlighted

#### Scenario: No highlight without an active query

- **WHEN** the filter bar is closed or the query is empty
- **THEN** messages render with no highlight

#### Scenario: Highlight aligns with displayed (JSON) text

- **WHEN** a shown message is JSON and rendered pretty-printed
- **THEN** the highlight marks the matched text within the pretty-printed output, not a different raw form
