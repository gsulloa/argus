## MODIFIED Requirements

### Requirement: API system prompt is assembled in a stable section order

`build_api_system_prompt` SHALL assemble its output as ordered, delimited sections in a fixed order: (1) role and hard SQL-only restrictions, (2) the context payload, then (3) when present, the attached query results. The role/restriction section SHALL precede the context section, and the context section SHALL precede the attachments section. When no attachments are present, the context section SHALL be the final section produced, leaving output byte-identical to the no-attachment case. The token count used for context-window trimming SHALL be measured over the builder's complete output string, not estimated per-section. Before composing, the API providers SHALL evict the oldest attachment first when the attachments would push the request over the soft cap, in addition to the existing per-turn trimming.

#### Scenario: Role section precedes context section

- **WHEN** `build_api_system_prompt(payload, attachments)` is built
- **THEN** the SQL-only role/restriction section appears before the serialized context payload section
- **AND** the sections are separated by clear delimiters

#### Scenario: Attachments section is last when present

- **WHEN** `build_api_system_prompt(payload, attachments)` is built with a non-empty attachments list
- **THEN** the attachments section appears after the context payload section as the final section

#### Scenario: No attachments leaves output unchanged

- **WHEN** `build_api_system_prompt(payload, attachments)` is built with an empty attachments list
- **THEN** the output is byte-identical to the prior two-section output (role, then context)

#### Scenario: Token count reflects the full composed prompt

- **WHEN** context-window trimming computes `system_chars`
- **THEN** it uses the length of the complete system-prompt string returned by the builder, not a per-section estimate

#### Scenario: Oldest attachment evicted before per-turn trimming

- **WHEN** the serialized attachments plus history would exceed the soft cap
- **THEN** the oldest attachment is dropped first, repeating until the attachments fit
- **AND** this eviction runs in addition to, not instead of, the existing per-turn trimming
