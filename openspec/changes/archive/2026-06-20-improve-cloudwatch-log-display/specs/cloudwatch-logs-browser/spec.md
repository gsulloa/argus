## ADDED Requirements

### Requirement: Log-readable event tail rendering

The raw event tail viewer SHALL render events for readability, consistent with the Insights result panel and `DESIGN.md` (compact density, hairline borders, `--font-mono`, single accent, no decorative gradients or thick borders). The event timestamp SHALL render as a fixed-width, human-readable local datetime with milliseconds, and a long event message SHALL be readable in full — wrapped and selectable, with JSON messages pretty-printed — rather than clipped to a single line. The viewer remains read-only and keeps its "load older / newer" paging.

#### Scenario: Event timestamp is human-readable

- **WHEN** the events viewer shows a stream's events
- **THEN** each event's timestamp renders as a local datetime down to milliseconds in a monospace, fixed-width column

#### Scenario: Long / JSON messages are readable

- **WHEN** an event message is long or is valid JSON
- **THEN** the viewer shows the full message wrapped and selectable, with JSON pretty-printed, without horizontal clipping

#### Scenario: Paging and read-only behavior preserved

- **WHEN** the user loads older or newer events
- **THEN** paging works as before and no control to edit a log event is present
