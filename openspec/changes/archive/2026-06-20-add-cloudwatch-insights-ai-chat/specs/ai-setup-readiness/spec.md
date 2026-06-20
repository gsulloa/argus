## MODIFIED Requirements

### Requirement: AI readiness state

The system SHALL derive a single AI readiness state for the active connection,
exposing exactly one of three values: `not-configured` (no provider),
`needs-context` (provider configured but the context-folder prerequisite is
unmet), or `ready`.

A provider is considered configured when a global default provider exists OR a
per-connection override exists for the active connection. A context folder is
considered available when it is linked AND its objects can be listed; a folder
that is linked but missing/unreadable on disk SHALL be treated as unavailable.

Connections belong to one of two readiness profiles:
- **Context-required** (Postgres, MySQL, MSSQL, Athena, DynamoDB): readiness is
  derived from BOTH prerequisites — a configured provider and an available
  context folder. The state is `needs-context` when a provider is configured but
  no context folder is linked, or a linked folder is unavailable on disk; it is
  `ready` only when both are satisfied.
- **Context-optional** (CloudWatch): readiness is derived from the provider
  prerequisite ALONE. The state is `ready` as soon as a provider is configured,
  whether or not a context folder is linked, and SHALL NEVER be `needs-context`.

#### Scenario: No provider configured

- **WHEN** no global default provider and no per-connection override exist for the active connection
- **THEN** the readiness state SHALL be `not-configured`

#### Scenario: Context-required connection with provider but no context folder

- **WHEN** the connection is context-required AND a provider is configured AND no context folder is linked
- **THEN** the readiness state SHALL be `needs-context`

#### Scenario: Context-required connection with context folder missing on disk

- **WHEN** the connection is context-required AND a provider is configured AND a context folder is linked but unavailable on disk
- **THEN** the readiness state SHALL be `needs-context`

#### Scenario: Context-required connection with all prerequisites met

- **WHEN** the connection is context-required AND a provider is configured AND a context folder is linked and available on disk
- **THEN** the readiness state SHALL be `ready`

#### Scenario: Context-optional connection ready on provider alone

- **WHEN** the connection is context-optional (CloudWatch) AND a provider is configured
- **THEN** the readiness state SHALL be `ready` regardless of whether a context folder is linked
- **AND** the readiness state SHALL NEVER be `needs-context`

#### Scenario: Readiness updates reactively

- **WHEN** the user configures a provider or links a context folder while the readiness is being displayed
- **THEN** the readiness state SHALL recompute and update its consumers without requiring a manual refresh

### Requirement: Setup checklist in the AI panel

When the readiness state is not `ready`, the AI panel SHALL render a setup
checklist instead of the chat conversation. The checklist SHALL list each
unmet prerequisite as satisfied or unsatisfied, and each unsatisfied item SHALL
present a direct call-to-action to complete it.

For **context-required** connections the checklist SHALL list both prerequisites
— AI provider and context folder. For **context-optional** connections the
checklist SHALL NOT present the context folder as a required prerequisite; it
SHALL list only the AI provider (the context folder MAY be offered as optional,
but never as a blocking requirement).

The provider CTA SHALL open the "AI: Configure providers" settings. The context
folder CTA (when shown) SHALL open the connection form where the context folder
can be linked.

#### Scenario: Checklist shown when provider missing

- **WHEN** the readiness state is `not-configured` and the user opens the AI panel
- **THEN** the panel SHALL show the setup checklist with the provider item unsatisfied and a CTA to configure providers

#### Scenario: Context-required checklist shows context item

- **WHEN** the connection is context-required, the readiness state is `needs-context`, and the user opens the AI panel
- **THEN** the panel SHALL show the setup checklist with the provider item satisfied, the context folder item unsatisfied, and a CTA to link a context folder

#### Scenario: Context-optional checklist omits the required context item

- **WHEN** the connection is context-optional and no provider is configured
- **THEN** the setup checklist SHALL list only the AI provider as a required prerequisite
- **AND** SHALL NOT present the context folder as a blocking requirement

#### Scenario: Provider CTA opens settings

- **WHEN** the user activates the provider CTA in the checklist
- **THEN** the "AI: Configure providers" settings SHALL open

#### Scenario: Context CTA opens connection form

- **WHEN** the user activates the context folder CTA in the checklist
- **THEN** the connection form for the active connection SHALL open so a context folder can be linked

#### Scenario: Panel transitions to chat when ready

- **WHEN** the readiness state becomes `ready` while the setup checklist is displayed
- **THEN** the panel SHALL replace the checklist with the chat conversation interface

### Requirement: Chat gated on prerequisites

The system SHALL allow AI chat usage only when the readiness state is `ready`.
Chat input SHALL be unavailable (hidden or disabled) while the readiness state is
`not-configured` or `needs-context`, and no chat session SHALL be created until
the readiness state is `ready`. For context-optional connections, `ready` is
reached on a configured provider alone, so chat SHALL be usable without a linked
context folder.

#### Scenario: Chat input unavailable when not ready

- **WHEN** the readiness state is `not-configured` or `needs-context`
- **THEN** the chat input SHALL be unavailable and no message can be sent

#### Scenario: No session created before ready

- **WHEN** the AI panel is open and the readiness state is not `ready`
- **THEN** no chat session SHALL be created

#### Scenario: Chat usable when ready

- **WHEN** the readiness state is `ready` and the AI panel is open
- **THEN** the chat input SHALL be available and the user can send a message

#### Scenario: Context-optional chat usable without a context folder

- **WHEN** the connection is context-optional, a provider is configured, and no context folder is linked
- **THEN** the readiness state SHALL be `ready` and the chat input SHALL be available

### Requirement: Removal of degraded no-context chat mode

For **context-required** connections, the system SHALL NOT run AI chat in a
degraded mode when no context folder is available: the panel SHALL show the
blocking setup checklist rather than opening chat with an empty or
temp-directory payload.

For **context-optional** connections (CloudWatch), chat without a context folder
is NOT a degraded mode — it is the supported default. The system SHALL permit
chatting with no linked context folder; API providers receive an empty context
payload and CLI providers run from the system temp directory, for all four
providers.

#### Scenario: No degraded chat without context for context-required connections

- **WHEN** a context-required connection has a provider configured but no context folder available
- **THEN** the panel SHALL show the setup checklist and SHALL NOT permit chatting with an empty/degraded payload

#### Scenario: Folder-free chat is supported for context-optional connections

- **WHEN** a context-optional connection has a provider configured and no context folder linked
- **THEN** the panel SHALL permit chatting
- **AND** chat SHALL function across all four providers (Claude Code, Codex CLI, Anthropic API, OpenAI API)
