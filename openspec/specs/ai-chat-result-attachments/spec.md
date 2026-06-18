# ai-chat-result-attachments Specification

## Purpose
TBD - created by archiving change attach-query-results-to-chat. Update Purpose after archive.
## Requirements
### Requirement: Executed query results are captured into chat session state

The chat panel SHALL capture the most recent successfully executed SQL result (column names, rows, and a truncation marker) into in-memory session state so it can be offered as context for a subsequent AI turn. Each captured result SHALL be capped to the first 100 rows or 50 KB serialised, whichever is reached first; when capped, the capture SHALL set a `truncated` flag and retain the true total `row_count`. Captured results SHALL NOT be written to disk and SHALL be discarded when the chat session ends.

#### Scenario: Successful result is captured

- **WHEN** a SQL query executes successfully and returns rows while the chat panel is open
- **THEN** the result's column names, rows, and total row count are available to the chat panel as a candidate attachment

#### Scenario: Large result is truncated at capture

- **WHEN** a result exceeding 100 rows or 50 KB serialised is captured
- **THEN** the stored attachment contains at most the first 100 rows (or up to 50 KB)
- **AND** its `truncated` flag is set
- **AND** its `row_count` reflects the true total number of rows, not the capped count

#### Scenario: Captures do not survive the session

- **WHEN** the chat session is closed or the app restarts
- **THEN** no captured result is persisted to disk or restored

### Requirement: User attaches and removes results from the composer

The chat panel SHALL present a composer-level affordance to attach the current executed result as context for the next message, labelled with its row count (e.g. "Attach result (N rows)"). The user SHALL be able to attach multiple results, each shown as a removable chip above the composer, and SHALL be able to remove any attachment before sending. Attached results SHALL be sent with the next user message and SHALL reuse the existing accent and radius design tokens (no new colors).

#### Scenario: Attaching the current result

- **WHEN** a result is available and the user activates the attach affordance
- **THEN** a removable chip representing that result appears above the composer
- **AND** the next message sent includes that result as context

#### Scenario: Multiple attachments

- **WHEN** the user attaches more than one result
- **THEN** each appears as its own removable chip
- **AND** all attached results are included with the next message

#### Scenario: Removing an attachment

- **WHEN** the user removes an attachment chip before sending
- **THEN** that result is not included with the next message

### Requirement: Attachments use one cross-provider wire shape

`ChatRequest` SHALL carry an optional `attached_results` collection of `AttachedResult` values, each with an id, column names, stringified rows, a `truncated` flag, and the true `row_count`. The same shape SHALL be produced regardless of the selected provider so the frontend manages exactly one representation. Row cells SHALL be stringified at the frontend boundary, with SQL `NULL` rendered as `NULL`.

#### Scenario: Request carries attachments verbatim

- **WHEN** the user sends a message with one or more attached results
- **THEN** the resulting `ChatRequest` carries those results in `attached_results` with their columns, rows, `truncated` flag, and `row_count` intact

#### Scenario: Identical shape across providers

- **WHEN** the active provider is any of claude-cli, codex-cli, anthropic-api, or openai-api
- **THEN** the attachments are carried in the same `AttachedResult` shape on the request

### Requirement: Attachments are serialised into each provider's prompt

API providers (`anthropic-api`, `openai-api`) SHALL serialise attached results as the trailing section of `build_api_system_prompt`, after the database-context section. CLI providers (`claude-cli`, `codex-cli`) SHALL serialise attached results as a fenced markdown table with a header identifying the result, prepended to the latest user turn at the designated insertion points, without colliding with the separately injected CLI system prompt. The serialised form SHALL indicate when a result was truncated.

#### Scenario: API provider appends attachments after context

- **WHEN** `build_api_system_prompt` is built with a non-empty attachments list
- **THEN** the attachments appear as the final section, after the `# Database context` section
- **AND** a truncated attachment is marked as truncated in the serialised text

#### Scenario: CLI provider prepends a markdown table to the latest user turn

- **WHEN** the flattened CLI prompt is built with a non-empty attachments list
- **THEN** a fenced markdown table of the attached result(s), with an identifying header, precedes the latest user request
- **AND** the CLI system prompt remains injected separately and unaltered

#### Scenario: No attachments leaves prompts unchanged

- **WHEN** the attachments list is empty
- **THEN** the API system prompt and the flattened CLI prompt are byte-identical to their pre-attachment output

### Requirement: Oldest attachment is evicted first when over the token budget

When the serialised attachments would push the request over the existing context-window soft cap, the system SHALL drop the oldest attachment first, repeating until the attachments portion fits, before the existing turn-trimming runs. This eviction SHALL occur in addition to, not instead of, the existing per-turn trimming, and the user SHALL be informed via a status update when an attachment is dropped.

#### Scenario: Oldest attachment dropped first

- **WHEN** the combined attachments and history would exceed the soft cap
- **THEN** the oldest attachment is removed first
- **AND** removal repeats from oldest to newest until the attachments fit
- **AND** conversation history is not trimmed in place of dropping attachments

#### Scenario: Eviction is surfaced to the user

- **WHEN** one or more attachments are evicted to fit the budget
- **THEN** a status update reports that attachment(s) were dropped

