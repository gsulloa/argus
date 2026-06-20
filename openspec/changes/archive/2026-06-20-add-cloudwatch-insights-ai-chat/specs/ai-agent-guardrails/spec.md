## MODIFIED Requirements

### Requirement: Agent emits SQL, never executes it

Every AI provider SHALL instruct the agent to respond with a query only — never to execute it — inside a single fenced code block, for Argus to execute. The query language SHALL match the connection's engine: for SQL engines (Postgres, MySQL, MSSQL, Athena) and when the engine is unknown, the agent SHALL be instructed to emit SQL inside a fenced ` ```sql ` block; for CloudWatch connections the agent SHALL be instructed to emit a CloudWatch Logs Insights query (pipe syntax — e.g. `fields`, `filter`, `stats`, `sort`, `limit`, `parse`, and `@`-fields) inside a fenced ` ```cwlogs ` block. The agent MUST be told it is forbidden from executing the query itself via any shell, Bash, MCP, or database/log tool (`psql`, `mysql`, `mariadb`, `sqlcmd`, `aws dynamodb`, `aws logs`, or equivalents). The agent MAY be granted exactly one Argus-owned, write-only MCP tool for documenting object docs (`document_object`); this tool SHALL NOT be able to execute queries, run a database CLI, reach a database, or write outside the connection's context root.

#### Scenario: SQL-only clause present on SQL-engine system prompts

- **WHEN** the system prompt is built for a SQL-engine connection (Postgres, MySQL, MSSQL, Athena) or an unknown engine, for any provider (claude-cli, codex-cli, anthropic-api, openai-api)
- **THEN** it contains an instruction to emit SQL inside a fenced ` ```sql ` block
- **AND** it contains an explicit instruction NOT to execute the query or run database CLIs

#### Scenario: Logs Insights clause present on CloudWatch system prompts

- **WHEN** the system prompt is built for a CloudWatch connection, for any provider (claude-cli, codex-cli, anthropic-api, openai-api)
- **THEN** it instructs the agent to emit a CloudWatch Logs Insights query inside a fenced ` ```cwlogs ` block
- **AND** it does NOT instruct the agent to emit SQL
- **AND** it contains an explicit instruction NOT to execute the query or run `aws logs`

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
