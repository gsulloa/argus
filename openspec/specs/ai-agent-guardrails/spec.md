# ai-agent-guardrails Specification

## Purpose
Defines the system-prompt contract and tool-access restrictions that pin the AI agent to emitting SQL only — never executing it — while treating the connection's context folder (and its parent) as the authoritative information source. Applies uniformly across all four providers (claude-cli, codex-cli, anthropic-api, openai-api), with claude additionally enforced at the tool layer (read-only tools, no external MCP servers).
## Requirements
### Requirement: Agent emits SQL, never executes it

Every AI provider SHALL instruct the agent to respond with SQL only, inside a fenced ` ```sql ` code block, for Argus to execute. The agent MUST be told it is forbidden from executing SQL itself via any shell, Bash, MCP, or database tool (`psql`, `mysql`, `mariadb`, `sqlcmd`, `aws dynamodb`, `aws logs`, or equivalents). The agent MAY be granted exactly one Argus-owned, write-only MCP tool for documenting object docs (`document_object`); this tool SHALL NOT be able to execute SQL, run a database CLI, reach a database, or write outside the connection's context root.

#### Scenario: SQL-only clause present on every provider's system prompt

- **WHEN** the system prompt is built for any provider (claude-cli, codex-cli, anthropic-api, openai-api)
- **THEN** it contains an instruction to emit SQL inside a fenced ` ```sql ` block
- **AND** it contains an explicit instruction NOT to execute SQL or run database CLIs

#### Scenario: claude is tool-restricted to read-only built-ins plus the documentation tool

- **WHEN** the claude CLI is spawned for `generate_sql` or `chat`
- **THEN** the constructed argv restricts available built-in tools to read-only ones (`Read Glob Grep`)
- **AND** the argv passes `--strict-mcp-config`, so no user/project MCP server is loaded
- **AND** the only MCP server loaded is Argus's own write-only documentation server (passed via `--mcp-config`), and only when the connection has a linked context folder
- **AND** the `document_object` MCP tool is the only non-read-only tool available, and it cannot execute SQL, run a database CLI, or write outside the context root
- **AND** Bash, command-execution tools, and external MCP tools are all unavailable, so the agent cannot run a database CLI or reach a DB MCP server even if instructed to
- **AND** the positional prompt is preceded by a `--` option terminator so the variadic `--tools` flag does not consume it

#### Scenario: claude has no documentation tool without a context folder

- **WHEN** the claude CLI is spawned for a connection that has no linked context folder
- **THEN** no `--mcp-config` is passed and `document_object` is unavailable
- **AND** the agent retains only the read-only built-in tools

### Requirement: Agent treats the context folder as the primary source

The CLI system prompt SHALL name the working directory (the connection's context folder) as the primary, authoritative source of information, directing the agent to read `manifest.json`, `overview.md`, `glossary.md`, `objects/`, and `queries/` before answering. The API system prompt, which receives the context as a serialized payload rather than files, SHALL reference that embedded payload as authoritative and SHALL NOT instruct the agent to read files from disk.

#### Scenario: CLI prompt points at the context folder

- **WHEN** `build_cli_system_prompt(context_path)` is built
- **THEN** the prompt references the context folder as the primary information source
- **AND** it names the on-disk artifacts (`manifest.json`, `overview.md`, `glossary.md`, `objects/`, `queries/`) to read first

#### Scenario: API prompt uses the embedded payload, not filesystem language

- **WHEN** `build_api_system_prompt(payload)` is built
- **THEN** the prompt embeds the serialized context payload as the authoritative source
- **AND** the prompt contains no instruction to read files or directories from disk

### Requirement: Agent consults parent-directory cross-connection docs

The CLI system prompt SHALL direct the agent to consult the parent directory (`../` of the context folder) as a secondary source for cross-connection skills and project-level documentation.

#### Scenario: CLI prompt references the parent directory

- **WHEN** `build_cli_system_prompt(context_path)` is built
- **THEN** the prompt references `../` (the parent of the context folder) as a secondary source for cross-connection/project-level docs

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

### Requirement: System prompt is applied on every turn for every provider

The system prompt SHALL be applied to every turn of both `generate_sql` and `chat`, for all four providers. For claude this includes both the `--resume` path and the full-history-replay fallback path. For codex, which has no system-prompt flag, the system prompt SHALL be prepended to the flattened conversation history.

#### Scenario: claude applies the system prompt on the resume path

- **WHEN** claude `chat()` runs with a stored resume id
- **THEN** the spawned argv includes the SQL-only system prompt
- **AND** the same is true on the full-history fallback path when resume is unavailable

#### Scenario: codex prepends the system prompt to history

- **WHEN** codex `chat()` flattens conversation history into a prompt
- **THEN** the final prompt is `"{system}\n\n{flattened_history}"` with the SQL-only system prompt first

#### Scenario: API providers apply the system prompt on both paths

- **WHEN** an API provider runs either `generate_sql` or `chat`
- **THEN** the request's system prompt is produced by `build_api_system_prompt`

