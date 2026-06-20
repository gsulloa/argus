## ADDED Requirements

### Requirement: The query's own limit is honored

When the Insights query string contains a `limit` command (e.g. `| limit 100`), the run SHALL NOT send a `StartQuery` `limit` parameter, so the query's own limit governs the number of returned rows. When the query string contains no `limit` command, the run MAY apply a default limit, which MUST never exceed the client result row cap. The client row cap (with the `truncated` flag) remains the hard upper bound in all cases.

#### Scenario: Query limit is respected

- **WHEN** the user runs `fields @timestamp, @message | limit 100` over a log group with thousands of matching events
- **THEN** the result contains at most 100 rows (the query's limit), not the default

#### Scenario: Limitless query is still capped

- **WHEN** the user runs a query with no `limit` command that would match more rows than the client row cap
- **THEN** the result is capped at the row cap and `truncated` is `true`

### Requirement: Log-readable result rendering

The Insights result panel SHALL render results for readability as a log viewer, not a generic spreadsheet, following `DESIGN.md` (compact density, hairline borders, `--font-mono` data, single accent, no decorative gradients or thick borders). Specifically: a timestamp column SHALL be rendered as a fixed-width, human-readable local datetime with milliseconds; and any row SHALL be expandable to reveal its full message text, wrapped and selectable, with JSON values pretty-printed. Sorting, cell-copy, and export remain available.

#### Scenario: Timestamp is human-readable

- **WHEN** a result includes a `@timestamp` column
- **THEN** each timestamp renders as a local datetime down to milliseconds in a monospace, fixed-width column, with rows aligned

#### Scenario: Expand a row to read the full message

- **WHEN** the user clicks a result row whose `@message` is longer than the cell width
- **THEN** an inline detail view reveals the full message, wrapped and selectable, without truncation

#### Scenario: JSON messages are pretty-printed

- **WHEN** an expanded row's message is valid JSON
- **THEN** the detail view shows it pretty-printed (indented), not as a single unformatted line

#### Scenario: Export and sort are unaffected

- **WHEN** the user sorts by a column or exports the result while rows are expandable
- **THEN** sorting and CSV/JSONL/XLSX export behave exactly as before
